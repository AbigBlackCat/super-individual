import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopDataDirectory, desktopBinary, desktopSearchPath } from './runtime.mjs';
test('Windows runtime uses exe files and the user AppData directory', () => {
 assert.equal(desktopBinary('node', 'win32'), 'node.exe');
 assert.equal(desktopBinary('node', 'darwin'), 'node');
 assert.equal(desktopDataDirectory('win32', {APPDATA:'C:\\Users\\Test\\AppData\\Roaming'}, 'C:\\Users\\Test'), 'C:\\Users\\Test\\AppData\\Roaming\\super individual');
 const value=desktopSearchPath('C:\\SI\\resources','win32',{APPDATA:'C:\\Users\\Test\\AppData\\Roaming',Path:'C:\\Windows\\System32'},'C:\\Users\\Test');
 assert.ok(value.includes(';'));assert.ok(value.includes('C:\\Windows\\System32'));assert.ok(value.includes('Roaming\\npm'));assert.ok(!value.includes('/usr/bin'));
});
