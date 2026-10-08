// Read PE imports without trusting a developer machine's DLL search path.
export function peImports(bytes) {
  const need = (offset, length) => { if (offset < 0 || offset + length > bytes.length) throw Error('Invalid PE bounds'); };
  need(0, 64);
  if (bytes.readUInt16LE(0) !== 0x5a4d) throw Error('Not a PE image');
  const pe = bytes.readUInt32LE(0x3c); need(pe, 24);
  if (bytes.readUInt32LE(pe) !== 0x4550) throw Error('Invalid PE signature');
  const count = bytes.readUInt16LE(pe + 6);
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const optional = pe + 24; need(optional, optionalSize);
  const magic = bytes.readUInt16LE(optional);
  const directories = optional + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : (() => { throw Error('Unsupported PE layout'); })());
  const sections = [];
  for (let i = 0; i < count; i++) {
    const offset = optional + optionalSize + i * 40; need(offset, 40);
    sections.push({ rva: bytes.readUInt32LE(offset + 12), size: bytes.readUInt32LE(offset + 16), file: bytes.readUInt32LE(offset + 20) });
  }
  const offsetOf = rva => {
    const section = sections.find(s => rva >= s.rva && rva < s.rva + s.size);
    if (!section) throw Error('Unmapped PE import');
    return section.file + rva - section.rva;
  };
  const nameOf = rva => {
    const offset = offsetOf(rva); need(offset, 1);
    const end = bytes.indexOf(0, offset);
    if (end < offset || end - offset > 260) throw Error('Invalid PE import name');
    const name = bytes.toString('ascii', offset, end).toLowerCase();
    if (!/^[a-z0-9_.-]+\.dll$/.test(name)) throw Error('Unsafe PE import name');
    return name;
  };
  const names = new Set();
  for (const [index, width, nameOffset] of [[1, 20, 12], [13, 32, 4]]) {
    if (directories + index * 8 + 8 > optional + optionalSize) continue;
    const rva = bytes.readUInt32LE(directories + index * 8);
    if (!rva) continue;
    let offset = offsetOf(rva);
    for (let i = 0; i < 2048; i++, offset += width) {
      need(offset, width);
      const name = bytes.readUInt32LE(offset + nameOffset);
      if (!name) break;
      if (index === 13 && !(bytes.readUInt32LE(offset) & 1)) throw Error('Unsupported non-RVA delayed PE import');
      names.add(nameOf(name));
      if (i === 2047) throw Error('Too many PE imports');
    }
  }
  return [...names].sort();
}
