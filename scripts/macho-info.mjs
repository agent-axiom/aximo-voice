export function machoInfo(bytes) {
  const need = (offset, length) => { if (offset < 0 || length < 0 || offset + length > bytes.length) throw Error('Invalid Mach-O bounds'); };
  need(0, 32);
  if (bytes.readUInt32LE(0) !== 0xfeedfacf) throw Error('Expected thin little-endian 64-bit Mach-O');
  const count = bytes.readUInt32LE(16);
  const answer = { minimumOS: null, dependencies: [], rpaths: [], infoPlist: null };
  let offset = 32;
  const version = v => `${v >>> 16}.${(v >>> 8) & 255}.${v & 255}`;
  for (let i = 0; i < count; i++) {
    need(offset, 8);
    const command = bytes.readUInt32LE(offset), size = bytes.readUInt32LE(offset + 4);
    if (size < 8) throw Error('Invalid Mach-O command');
    need(offset, size);
    const name = () => {
      const start = offset + bytes.readUInt32LE(offset + 8);
      if (start < offset || start >= offset + size) throw Error('Invalid Mach-O string');
      const end = bytes.indexOf(0, start);
      if (end < start || end >= offset + size) throw Error('Unterminated Mach-O string');
      return bytes.toString('utf8', start, end);
    };
    if ([0xc, 0x80000018, 0x8000001f].includes(command)) answer.dependencies.push(name());
    if (command === 0x8000001c) answer.rpaths.push(name());
    if (command === 0x32) answer.minimumOS = version(bytes.readUInt32LE(offset + 12));
    if (command === 0x24) answer.minimumOS = version(bytes.readUInt32LE(offset + 8));
    if (command === 0x19) {
      need(offset, 72);
      const sections = bytes.readUInt32LE(offset + 64);
      if (72 + sections * 80 > size) throw Error('Invalid Mach-O sections');
      for (let j = 0; j < sections; j++) {
        const section = offset + 72 + j * 80;
        const sectionName = bytes.toString('ascii', section, section + 16).split('\0')[0];
        const segmentName = bytes.toString('ascii', section + 16, section + 32).split('\0')[0];
        if (sectionName === '__info_plist' && segmentName === '__TEXT') {
          const length = Number(bytes.readBigUInt64LE(section + 40)), start = bytes.readUInt32LE(section + 48);
          need(start, length); answer.infoPlist = bytes.toString('utf8', start, start + length);
        }
      }
    }
    offset += size;
  }
  return answer;
}
