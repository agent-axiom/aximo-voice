//! Windows-only private session directories. Win32 creates the protected DACL
//! atomically; retained, non-delete-shared handles pin every path component.
//! This does not defend against administrators, SYSTEM, or this user's processes.
use std::{
    ffi::{c_void, OsStr},
    mem::{size_of, zeroed},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Component, Path, Prefix},
    ptr::{null, null_mut},
};

use anyhow::{bail, ensure, Context, Result};
use windows_sys::Win32::{
    Foundation::{LocalFree, GENERIC_ALL, GENERIC_WRITE, INVALID_HANDLE_VALUE},
    Security::{
        AclSizeInformation,
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            GetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT,
        },
        GetAce, GetAclInformation, GetSecurityDescriptorControl, GetTokenInformation, IsValidAcl,
        IsValidSid, TokenUser, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION,
        CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, INHERIT_ONLY_ACE, OBJECT_INHERIT_ACE,
        OWNER_SECURITY_INFORMATION, PSID, SECURITY_ATTRIBUTES, SE_DACL_PRESENT, SE_DACL_PROTECTED,
        TOKEN_QUERY, TOKEN_USER,
    },
    Storage::FileSystem::{
        CreateDirectoryW, CreateFileW, GetDriveTypeW, GetFileInformationByHandle,
        GetVolumeInformationW, GetVolumePathNameW, BY_HANDLE_FILE_INFORMATION, DELETE,
        FILE_ALL_ACCESS, FILE_APPEND_DATA, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_DELETE_CHILD, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_WRITE_ATTRIBUTES,
        FILE_WRITE_DATA, FILE_WRITE_EA, OPEN_EXISTING, READ_CONTROL, WRITE_DAC, WRITE_OWNER,
    },
    System::{
        SystemServices::{ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE, FILE_PERSISTENT_ACLS},
        Threading::{GetCurrentProcess, OpenProcessToken},
        WindowsProgramming::DRIVE_FIXED,
    },
};

const SYSTEM_SID: &str = "S-1-5-18";
const ADMINISTRATORS_SID: &str = "S-1-5-32-544";

/// Kept alive through capture/inference or one whole control operation. Close it
/// before removing a session directory. OwnedHandle closes on every error path.
pub(crate) struct DirectoryGuard {
    _handles: Vec<OwnedHandle>,
}

struct LocalAllocation(*mut c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        // SAFETY: these pointers are allocated by the documented LocalAlloc APIs.
        unsafe { LocalFree(self.0) };
    }
}

fn wide(value: &OsStr) -> Result<Vec<u16>> {
    let mut out: Vec<_> = value.encode_wide().collect();
    ensure!(!out.contains(&0), "path contains a NUL character");
    out.push(0);
    Ok(out)
}

fn win32_ok(success: i32, operation: &str) -> Result<()> {
    if success == 0 {
        return Err(std::io::Error::last_os_error()).context(operation.to_owned());
    }
    Ok(())
}

fn sid_string(sid: PSID) -> Result<String> {
    // SAFETY: callers supply a SID inside an OS-returned token/descriptor which
    // remains allocated for this call. ConvertSidToStringSidW returns LocalAlloc.
    unsafe {
        ensure!(
            !sid.is_null() && IsValidSid(sid) != 0,
            "invalid Windows SID"
        );
        let mut text = null_mut();
        win32_ok(ConvertSidToStringSidW(sid, &mut text), "read Windows SID")?;
        let allocation = LocalAllocation(text.cast());
        let length = (0..256)
            .find(|index| *text.add(*index) == 0)
            .context("Windows SID string is too long")?;
        let value = String::from_utf16(std::slice::from_raw_parts(text, length))?;
        drop(allocation);
        Ok(value)
    }
}

fn current_user() -> Result<String> {
    // SAFETY: output buffers are correctly sized/aligned, token is owned, and the
    // TOKEN_USER SID is used before its backing allocation is dropped.
    unsafe {
        let mut raw = null_mut();
        win32_ok(
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw),
            "open user token",
        )?;
        let token = OwnedHandle::from_raw_handle(raw);
        let mut bytes = 0;
        GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut bytes);
        ensure!(
            (size_of::<TOKEN_USER>() as u32..=65536).contains(&bytes),
            "invalid token size"
        );
        let mut buffer = vec![0usize; (bytes as usize).div_ceil(size_of::<usize>())];
        win32_ok(
            GetTokenInformation(
                token.as_raw_handle(),
                TokenUser,
                buffer.as_mut_ptr().cast(),
                bytes,
                &mut bytes,
            ),
            "read user token",
        )?;
        sid_string((*(buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid)
    }
}

#[derive(Debug)]
struct Ace {
    kind: u8,
    flags: u8,
    mask: u32,
    sid: String,
}

struct Security {
    owner: String,
    protected: bool,
    aces: Vec<Ace>,
}

fn security(handle: &OwnedHandle) -> Result<Security> {
    // SAFETY: GetSecurityInfo owns one self-relative descriptor; all ACL/SID
    // pointers stay inside it until copied. GetAce is used only on a valid ACL.
    unsafe {
        let mut owner = null_mut();
        let mut acl: *mut ACL = null_mut();
        let mut descriptor = null_mut();
        let error = GetSecurityInfo(
            handle.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut acl,
            null_mut(),
            &mut descriptor,
        );
        if error != 0 {
            return Err(std::io::Error::from_raw_os_error(error as i32))
                .context("inspect directory ACL");
        }
        let _allocation = LocalAllocation(descriptor);
        let mut control = 0;
        let mut revision = 0;
        win32_ok(
            GetSecurityDescriptorControl(descriptor, &mut control, &mut revision),
            "inspect ACL protection",
        )?;
        ensure!(
            control & SE_DACL_PRESENT != 0 && !acl.is_null() && IsValidAcl(acl) != 0,
            "missing or invalid directory DACL"
        );
        let mut info: ACL_SIZE_INFORMATION = zeroed();
        win32_ok(
            GetAclInformation(
                acl,
                (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
                size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            ),
            "inspect ACL entries",
        )?;
        let mut aces = Vec::new();
        for index in 0..info.AceCount {
            let mut entry = null_mut();
            win32_ok(GetAce(acl, index, &mut entry), "read ACL entry")?;
            let header = &*entry.cast::<ACE_HEADER>();
            ensure!(
                u32::from(header.AceType) == ACCESS_ALLOWED_ACE_TYPE
                    || u32::from(header.AceType) == ACCESS_DENIED_ACE_TYPE,
                "unsupported directory ACL entry"
            );
            ensure!(
                usize::from(header.AceSize) >= size_of::<ACCESS_ALLOWED_ACE>(),
                "invalid ACL entry size"
            );
            let ace = &*entry.cast::<ACCESS_ALLOWED_ACE>();
            let sid_offset = std::mem::offset_of!(ACCESS_ALLOWED_ACE, SidStart);
            ensure!(
                usize::from(header.AceSize) >= sid_offset + 8,
                "invalid ACL SID header size"
            );
            let sid = std::ptr::addr_of!(ace.SidStart).cast::<u8>();
            let sid_length = 8 + 4 * usize::from(*sid.add(1));
            ensure!(
                sid_offset + sid_length <= usize::from(header.AceSize),
                "ACL SID extends beyond its entry"
            );
            aces.push(Ace {
                kind: ace.Header.AceType,
                flags: ace.Header.AceFlags,
                mask: ace.Mask,
                sid: sid_string(std::ptr::addr_of!(ace.SidStart).cast_mut().cast())?,
            });
        }
        Ok(Security {
            owner: sid_string(owner)?,
            protected: control & SE_DACL_PROTECTED != 0,
            aces,
        })
    }
}

fn open_directory(path: &Path, inspect_acl: bool) -> Result<OwnedHandle> {
    let path = wide(path.as_os_str())?;
    // SAFETY: NUL-terminated path and valid Win32 arguments. The handle is owned
    // immediately, including when attribute inspection fails.
    unsafe {
        let raw = CreateFileW(
            path.as_ptr(),
            FILE_READ_ATTRIBUTES | if inspect_acl { READ_CONTROL } else { 0 },
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        );
        if raw == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error()).context("pin session directory path");
        }
        let handle = OwnedHandle::from_raw_handle(raw);
        let mut info: BY_HANDLE_FILE_INFORMATION = zeroed();
        win32_ok(
            GetFileInformationByHandle(handle.as_raw_handle(), &mut info),
            "inspect session path",
        )?;
        ensure!(
            info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0
                && info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0,
            "session path must contain only real directories"
        );
        Ok(handle)
    }
}

fn local_volume(path: &Path) -> Result<()> {
    ensure!(path.is_absolute(), "TEMP must be an absolute local path");
    ensure!(
        matches!(path.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))),
        "network/device TEMP paths are unsupported"
    );
    ensure!(
        path.components()
            .all(|part| !matches!(part, Component::ParentDir)),
        "TEMP must not contain parent traversal"
    );
    let path = wide(path.as_os_str())?;
    let mut volume = vec![0u16; 32768];
    let mut flags = 0;
    // SAFETY: path is terminated and volume has the advertised output capacity.
    unsafe {
        win32_ok(
            GetVolumePathNameW(path.as_ptr(), volume.as_mut_ptr(), volume.len() as u32),
            "locate TEMP volume",
        )?;
        ensure!(
            GetDriveTypeW(volume.as_ptr()) == DRIVE_FIXED,
            "TEMP must use a local fixed volume"
        );
        win32_ok(
            GetVolumeInformationW(
                volume.as_ptr(),
                null_mut(),
                0,
                null_mut(),
                null_mut(),
                &mut flags,
                null_mut(),
                0,
            ),
            "inspect TEMP volume",
        )?;
    }
    ensure!(
        flags & FILE_PERSISTENT_ACLS != 0,
        "TEMP volume must enforce Windows ACLs"
    );
    Ok(())
}

fn pin_parent(path: &Path, user: &str) -> Result<Vec<OwnedHandle>> {
    let parent = path.parent().context("session directory needs a parent")?;
    local_volume(parent)?;
    let ancestors: Vec<_> = parent.ancestors().collect();
    let mut handles = Vec::new();
    // Lock root-to-leaf, so no already-checked component can be renamed while
    // opening the next one. Reparse points are rejected rather than followed.
    for ancestor in ancestors.into_iter().rev() {
        handles.push(open_directory(ancestor, ancestor == parent)?);
    }
    let info = security(handles.last().context("missing TEMP directory")?)?;
    let trusted = |sid: &str| sid == user || sid == SYSTEM_SID || sid == ADMINISTRATORS_SID;
    ensure!(trusted(&info.owner), "TEMP owner is not trusted");
    for ace in info.aces {
        if u32::from(ace.kind) == ACCESS_ALLOWED_ACE_TYPE
            && u32::from(ace.flags) & INHERIT_ONLY_ACE == 0
            && !trusted(&ace.sid)
            && ace.mask
                & (WRITE_DAC
                    | WRITE_OWNER
                    | DELETE
                    | FILE_DELETE_CHILD
                    | GENERIC_ALL
                    | GENERIC_WRITE
                    | FILE_WRITE_DATA
                    | FILE_APPEND_DATA
                    | FILE_WRITE_EA
                    | FILE_WRITE_ATTRIBUTES)
                != 0
        {
            bail!("TEMP permits another principal to replace or change session directories");
        }
    }
    Ok(handles)
}

fn check_private(handle: &OwnedHandle, user: &str) -> Result<()> {
    let info = security(handle)?;
    ensure!(
        info.owner == user && info.protected,
        "session owner or protected DACL is invalid"
    );
    ensure!(
        info.aces.len() == 2,
        "session must permit only this user and SYSTEM"
    );
    for sid in [user, SYSTEM_SID] {
        ensure!(
            info.aces.iter().any(|ace| ace.sid == sid
                && u32::from(ace.kind) == ACCESS_ALLOWED_ACE_TYPE
                && u32::from(ace.flags) == (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)
                && ace.mask == FILE_ALL_ACCESS),
            "session DACL is not private"
        );
    }
    Ok(())
}

fn create_with_sddl(path: &Path, sddl: &str) -> Result<()> {
    let sddl = wide(OsStr::new(sddl))?;
    let path = wide(path.as_os_str())?;
    // SAFETY: descriptor and strings outlive CreateDirectoryW. The descriptor
    // has a protected DACL before creation; there is no public creation window.
    unsafe {
        let mut descriptor = null_mut();
        win32_ok(
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            ),
            "build private directory ACL",
        )?;
        let _allocation = LocalAllocation(descriptor);
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        win32_ok(
            CreateDirectoryW(path.as_ptr(), &attributes),
            "create exclusive private session directory",
        )
    }
}

pub(crate) fn create_private(path: &Path) -> Result<DirectoryGuard> {
    let user = current_user()?;
    let mut handles = pin_parent(path, &user)?;
    create_with_sddl(
        path,
        &format!("O:{user}D:P(A;OICI;FA;;;{user})(A;OICI;FA;;;SY)"),
    )?;
    let child = open_directory(path, true)?;
    check_private(&child, &user)?;
    handles.push(child);
    Ok(DirectoryGuard { _handles: handles })
}

pub(crate) fn open_private(path: &Path) -> Result<DirectoryGuard> {
    let user = current_user()?;
    let mut handles = pin_parent(path, &user)?;
    let child = open_directory(path, true)?;
    check_private(&child, &user)?;
    handles.push(child);
    Ok(DirectoryGuard { _handles: handles })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Write};
    use windows_sys::Win32::Security::INHERITED_ACE;

    #[test]
    fn protected_child_and_wav_do_not_inherit_everyone_read() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("shared-read");
        let user = current_user().unwrap();
        create_with_sddl(
            &root,
            &format!("O:{user}D:P(A;OICI;FA;;;{user})(A;OICI;FA;;;SY)(A;OICI;FR;;;WD)"),
        )
        .unwrap();
        let child = root.join("session");
        let guard = create_private(&child).unwrap();
        let mut wav = tempfile::NamedTempFile::new_in(&child).unwrap();
        wav.write_all(b"synthetic test bytes, not microphone audio")
            .unwrap();
        let file = fs::File::open(wav.path()).unwrap();
        let handle: OwnedHandle = file.into();
        let info = security(&handle).unwrap();
        assert_eq!(info.owner, user);
        assert_eq!(info.aces.len(), 2);
        assert!(info
            .aces
            .iter()
            .all(|ace| (ace.sid == user || ace.sid == SYSTEM_SID)
                && u32::from(ace.kind) == ACCESS_ALLOWED_ACE_TYPE
                && u32::from(ace.flags) & INHERITED_ACE != 0));
        drop(handle);
        drop(wav);
        assert!(fs::rename(&child, root.join("swapped")).is_err());
        drop(guard);
        fs::remove_dir_all(&child).unwrap();
        assert!(!child.exists());
    }

    #[test]
    fn unsafe_parent_and_existing_public_child_are_refused() {
        let temp = tempfile::tempdir().unwrap();
        let user = current_user().unwrap();
        let unsafe_root = temp.path().join("shared-write");
        create_with_sddl(
            &unsafe_root,
            &format!("O:{user}D:P(A;OICI;FA;;;{user})(A;OICI;FA;;;SY)(A;OICI;FA;;;WD)"),
        )
        .unwrap();
        assert!(create_private(&unsafe_root.join("session")).is_err());
        assert!(!unsafe_root.join("session").exists());
        let public = temp.path().join("public");
        fs::create_dir(&public).unwrap();
        assert!(open_private(&public).is_err());
    }

    #[test]
    fn network_and_relative_temp_paths_are_refused() {
        assert!(local_volume(Path::new(r"\\server\share\temp")).is_err());
        assert!(local_volume(Path::new(r"\\?\UNC\server\share\temp")).is_err());
        assert!(local_volume(Path::new("relative-temp")).is_err());
    }
}
