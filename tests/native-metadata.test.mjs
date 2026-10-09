import test from 'node:test';
import assert from 'node:assert/strict';
import { peImports } from '../scripts/pe-imports.mjs';
import { machoInfo } from '../scripts/macho-info.mjs';

function pe() {
  const bytes = Buffer.alloc(2048), header = 0x80, optional = header + 24;
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(header, 0x3c);
  bytes.writeUInt32LE(0x4550, header); bytes.writeUInt16LE(1, header + 6);
  bytes.writeUInt16LE(240, header + 20); bytes.writeUInt16LE(0x20b, optional);
  const section = optional + 240;
  bytes.writeUInt32LE(0x1000, section + 12); bytes.writeUInt32LE(1024, section + 16); bytes.writeUInt32LE(512, section + 20);
  bytes.writeUInt32LE(0x1000, optional + 112 + 8);
  bytes.writeUInt32LE(0x1100, 512 + 12); bytes.write('KERNEL32.dll\0', 768);
  bytes.writeUInt32LE(0x1120, 532 + 12); bytes.write('vcruntime140.dll\0', 800);
  bytes.writeUInt32LE(0x1200, optional + 112 + 13 * 8);
  bytes.writeUInt32LE(1, 1024); bytes.writeUInt32LE(0x1240, 1028); bytes.write('msvcp140.dll\0', 1088);
  return bytes;
}
test('PE parser covers immediate and delayed CRT imports', () => {
  assert.deepEqual(peImports(pe()), ['kernel32.dll', 'msvcp140.dll', 'vcruntime140.dll']);
});
test('PE parser rejects traversal names and invalid image bounds', () => {
  const bytes = pe(); bytes.write('../evil.dll\0', 768); assert.throws(() => peImports(bytes));
  assert.throws(() => peImports(Buffer.alloc(8)));
  const broken = pe(); broken.writeUInt32LE(0x7fffffff, 0x3c); assert.throws(() => peImports(broken));
});

function macho() {
  const bytes = Buffer.alloc(1024);
  bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(3, 16);
  bytes.writeUInt32LE(0x32, 32); bytes.writeUInt32LE(24, 36); bytes.writeUInt32LE(0x000e0102, 44);
  bytes.writeUInt32LE(0x8000001c, 56); bytes.writeUInt32LE(32, 60); bytes.writeUInt32LE(12, 64); bytes.write('@executable_path\0', 68);
  bytes.writeUInt32LE(0x19, 88); bytes.writeUInt32LE(152, 92); bytes.writeUInt32LE(1, 88 + 64);
  const section = 88 + 72, plist = '<plist><dict><key>NSMicrophoneUsageDescription</key><string>Use microphone</string></dict></plist>';
  bytes.write('__info_plist', section); bytes.write('__TEXT', section + 16);
  bytes.writeBigUInt64LE(BigInt(plist.length), section + 40); bytes.writeUInt32LE(512, section + 48); bytes.write(plist, 512);
  return bytes;
}
test('Mach-O parser reads actual deployment floor and embedded microphone plist', () => {
  const info = machoInfo(macho());
  assert.equal(info.minimumOS, '14.1.2');
  assert.deepEqual(info.rpaths, ['@executable_path']);
  assert.match(info.infoPlist, /NSMicrophoneUsageDescription/);
});
test('Mach-O parser refuses truncated sections and unsupported files', () => {
  assert.throws(() => machoInfo(Buffer.alloc(32)));
  const bytes = macho(); bytes.writeUInt32LE(5000, 88 + 72 + 48); assert.throws(() => machoInfo(bytes));
});
