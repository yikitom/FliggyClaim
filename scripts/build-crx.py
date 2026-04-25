#!/usr/bin/env python3
"""
Pack the FliggyClaim extension into a CRX v3 file.

Output:
  dist/fliggyclaim-<version>.crx       Packed extension
  dist/fliggyclaim.pem                  Private key (do NOT publish; keep so the
                                        extension ID stays stable on next pack)

CRX v3 binary layout:
  "Cr24"                                       4 bytes magic
  uint32_LE(3)                                 version
  uint32_LE(header_len)                        length of CrxFileHeader proto
  CrxFileHeader proto                          contains signature + public key
  zip                                          the unpacked extension archive

Signature input (SHA-256 with RSA-PKCS1v15):
  b"CRX3 SignedData\\0"                         16-byte magic
  uint32_LE(len(signed_header_data))
  signed_header_data                           SignedData proto with crx_id
  zip
"""

from __future__ import annotations

import hashlib
import io
import os
import sys
import zipfile
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
KEY_PATH = DIST / "fliggyclaim.pem"


def varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def proto_field_bytes(field: int, value: bytes) -> bytes:
    tag = (field << 3) | 2  # wire type 2 = length-delimited
    return varint(tag) + varint(len(value)) + value


def build_extension_zip() -> bytes:
    buf = io.BytesIO()
    members = [
        "manifest.json",
        "background",
        "content",
        "icons",
        "lib",
        "options",
        "popup",
    ]
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for m in members:
            p = ROOT / m
            if p.is_file():
                zf.write(p, m)
            else:
                for sub in sorted(p.rglob("*")):
                    if sub.is_file() and not sub.name.startswith("."):
                        zf.write(sub, sub.relative_to(ROOT).as_posix())
    return buf.getvalue()


def load_or_create_key() -> rsa.RSAPrivateKey:
    if KEY_PATH.exists():
        return serialization.load_pem_private_key(KEY_PATH.read_bytes(), password=None)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    DIST.mkdir(exist_ok=True)
    KEY_PATH.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    KEY_PATH.chmod(0o600)
    return key


def extension_id_from_pubkey(pub_der: bytes) -> str:
    """First 16 bytes of SHA256(pub_der), mapped to a..p (one char per nibble)."""
    digest = hashlib.sha256(pub_der).digest()[:16]
    return "".join(chr(ord("a") + (b >> 4)) + chr(ord("a") + (b & 0xF)) for b in digest)


def main() -> int:
    import json

    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]

    DIST.mkdir(exist_ok=True)
    out_path = DIST / f"fliggyclaim-{version}.crx"

    print("→ Generating zip…")
    zip_bytes = build_extension_zip()

    print("→ Loading / creating signing key…")
    key = load_or_create_key()
    pub_der = key.public_key().public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    crx_id = hashlib.sha256(pub_der).digest()[:16]
    ext_id = extension_id_from_pubkey(pub_der)
    print(f"  Extension ID: {ext_id}")

    # SignedData { crx_id = bytes }
    signed_header_data = proto_field_bytes(1, crx_id)

    # Bytes that are signed
    sig_magic = b"CRX3 SignedData\x00"
    to_sign = (
        sig_magic
        + len(signed_header_data).to_bytes(4, "little")
        + signed_header_data
        + zip_bytes
    )

    print("→ Signing…")
    signature = key.sign(to_sign, padding.PKCS1v15(), hashes.SHA256())

    # AsymmetricKeyProof { public_key = pub_der, signature = signature }
    proof = proto_field_bytes(1, pub_der) + proto_field_bytes(2, signature)

    # CrxFileHeader { sha256_with_rsa = [proof], signed_header_data = signed_header_data }
    header = proto_field_bytes(2, proof) + proto_field_bytes(10000, signed_header_data)

    crx = (
        b"Cr24"
        + (3).to_bytes(4, "little")
        + len(header).to_bytes(4, "little")
        + header
        + zip_bytes
    )
    out_path.write_bytes(crx)

    size_kb = len(crx) / 1024
    print(f"✓ Wrote {out_path.relative_to(ROOT)} ({size_kb:.1f} KB)")
    print(f"  Private key: {KEY_PATH.relative_to(ROOT)}  (keep this safe, do not publish)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
