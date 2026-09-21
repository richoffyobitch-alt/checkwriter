"use strict";

/**
 * Identifies the platform and CPU architecture a compiled binary was built
 * for, by reading its header.
 *
 * The obvious implementation shells out to file(1). That works on Linux and
 * macOS and not on a Windows build runner, and a verification step that
 * quietly does nothing on one platform is worse than no verification at all
 * — it is the exact shape of bug this code exists to catch.
 *
 * So the headers are parsed directly. All three formats announce themselves
 * in their first few bytes, and the field holding the architecture is at a
 * fixed offset in each. Fewer than sixty bytes are read.
 */

const fs = require("node:fs");

/* Mach-O (macOS) */
const MH_MAGIC_64 = 0xfeedfacf; // little-endian 64-bit
const MH_CIGAM_64 = 0xcffaedfe; // byte-swapped
const FAT_MAGIC = 0xcafebabe; // universal binary, big-endian
const FAT_MAGIC_64 = 0xcafebabf;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

/* ELF (Linux) */
const EM_X86_64 = 0x3e;
const EM_AARCH64 = 0xb7;

/* PE (Windows) */
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const IMAGE_FILE_MACHINE_ARM64 = 0xaa64;

function readHead(file, length = 4096) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function machoArch(cpuType) {
  if (cpuType === CPU_TYPE_X86_64) return "x64";
  if (cpuType === CPU_TYPE_ARM64) return "arm64";
  return null;
}

/**
 * @returns {{platform: string|null, arches: string[], description: string}}
 *   `arches` is a list because a macOS universal binary genuinely contains
 *   more than one, and collapsing that to a single value would let a
 *   universal binary masquerade as whichever slice was checked first.
 */
function identify(file) {
  const head = readHead(file);
  if (head.length < 8) {
    return { platform: null, arches: [], description: "file too short to identify" };
  }

  const magicLE = head.readUInt32LE(0);
  const magicBE = head.readUInt32BE(0);

  /* Universal ("fat") Mach-O: a count, then one entry per slice. Fields are
     big-endian regardless of the slices inside. */
  if (magicBE === FAT_MAGIC || magicBE === FAT_MAGIC_64) {
    const count = head.readUInt32BE(4);
    const arches = [];
    /* Each fat_arch is 20 bytes (32-bit offsets) or 32 (64-bit), and the
       cputype is the first field either way. */
    const stride = magicBE === FAT_MAGIC_64 ? 32 : 20;
    for (let i = 0; i < count; i++) {
      const at = 8 + i * stride;
      if (at + 4 > head.length) break;
      const arch = machoArch(head.readUInt32BE(at));
      if (arch) arches.push(arch);
    }
    return {
      platform: "darwin",
      arches,
      description: `Mach-O universal binary (${arches.join(", ") || "unknown slices"})`,
    };
  }

  if (magicLE === MH_MAGIC_64 || magicLE === MH_CIGAM_64) {
    const swapped = magicLE === MH_CIGAM_64;
    const cpuType = swapped ? head.readUInt32BE(4) : head.readUInt32LE(4);
    const arch = machoArch(cpuType);
    return {
      platform: "darwin",
      arches: arch ? [arch] : [],
      description: `Mach-O 64-bit ${arch ?? `cputype 0x${cpuType.toString(16)}`}`,
    };
  }

  if (head.readUInt32BE(0) === 0x7f454c46) {
    /* ELF: e_machine is a 16-bit field at offset 18. Endianness is declared
       at offset 5 (1 = little, 2 = big). */
    const little = head[5] !== 2;
    const machine = little ? head.readUInt16LE(18) : head.readUInt16BE(18);
    const arch =
      machine === EM_X86_64 ? "x64" : machine === EM_AARCH64 ? "arm64" : null;
    return {
      platform: "linux",
      arches: arch ? [arch] : [],
      description: `ELF ${arch ?? `machine 0x${machine.toString(16)}`}`,
    };
  }

  if (head[0] === 0x4d && head[1] === 0x5a) {
    /* PE: the DOS stub holds the offset of the real header at 0x3C. */
    const peOffset = head.readUInt32LE(0x3c);
    if (peOffset + 6 <= head.length && head.readUInt32LE(peOffset) === 0x00004550) {
      const machine = head.readUInt16LE(peOffset + 4);
      const arch =
        machine === IMAGE_FILE_MACHINE_AMD64
          ? "x64"
          : machine === IMAGE_FILE_MACHINE_ARM64
            ? "arm64"
            : null;
      return {
        platform: "win32",
        arches: arch ? [arch] : [],
        description: `PE32+ ${arch ?? `machine 0x${machine.toString(16)}`}`,
      };
    }
    return { platform: "win32", arches: [], description: "MS-DOS/PE, header unreadable" };
  }

  return {
    platform: null,
    arches: [],
    description: `unrecognised format (magic 0x${magicBE.toString(16)})`,
  };
}

/**
 * Throws with an explanatory message unless `file` is a binary for exactly
 * the requested target.
 */
function assertTarget(file, wantPlatform, wantArch, context = "") {
  const found = identify(file);
  const where = context ? `${context}\n` : "";

  if (found.platform !== wantPlatform) {
    throw new Error(
      `${where}Wrong platform.\n` +
        `  wanted: ${wantPlatform}-${wantArch}\n` +
        `  found:  ${found.description}\n  file:   ${file}`,
    );
  }

  const ok =
    wantArch === "universal"
      ? found.arches.includes("x64") && found.arches.includes("arm64")
      : found.arches.length === 1 && found.arches[0] === wantArch;

  if (!ok) {
    throw new Error(
      `${where}Wrong architecture.\n` +
        `  wanted: ${wantPlatform}-${wantArch}\n` +
        `  found:  ${found.description}\n  file:   ${file}`,
    );
  }

  return found;
}

module.exports = { identify, assertTarget };
