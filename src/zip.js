(() => {
  'use strict';

  const ns = (globalThis.ChatGPTConversationExporter ||= {});
  if (ns.zip) return;

  const encoder = new TextEncoder();

  /**
   * Build a CRC32 lookup table once for ZIP file generation.
   */
  function buildCrcTable() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  }

  const CRC_TABLE = buildCrcTable();

  /**
   * Calculate CRC32 for a byte array.
   */
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let index = 0; index < bytes.length; index += 1) {
      crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function u16(value) {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value, true);
    return bytes;
  }

  function u32(value) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
  }

  function concat(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }

  function toDosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    const dosTime =
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2);
    const dosDate =
      ((year - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate();
    return { dosDate, dosTime };
  }

  /**
   * Create an uncompressed UTF-8 ZIP archive entirely in memory.
   * This intentionally uses STORE rather than DEFLATE so the extension has no third-party dependency.
   */
  function createZip(files) {
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    const now = new Date();
    const { dosDate, dosTime } = toDosDateTime(now);

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const dataBytes =
        file.data instanceof Uint8Array ? file.data : encoder.encode(String(file.data ?? ''));
      const checksum = crc32(dataBytes);
      const utf8Flag = 0x0800;

      const localHeader = concat([
        u32(0x04034b50),
        u16(20),
        u16(utf8Flag),
        u16(0),
        u16(dosTime),
        u16(dosDate),
        u32(checksum),
        u32(dataBytes.length),
        u32(dataBytes.length),
        u16(nameBytes.length),
        u16(0),
        nameBytes,
      ]);

      localParts.push(localHeader, dataBytes);

      const centralHeader = concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(utf8Flag),
        u16(0),
        u16(dosTime),
        u16(dosDate),
        u32(checksum),
        u32(dataBytes.length),
        u32(dataBytes.length),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(localOffset),
        nameBytes,
      ]);

      centralParts.push(centralHeader);
      localOffset += localHeader.length + dataBytes.length;
    }

    const localData = concat(localParts);
    const centralData = concat(centralParts);
    const endRecord = concat([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(files.length),
      u16(files.length),
      u32(centralData.length),
      u32(localData.length),
      u16(0),
    ]);

    return new Blob([localData, centralData, endRecord], { type: 'application/zip' });
  }

  ns.zip = { createZip };
})();
