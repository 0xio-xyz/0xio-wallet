#!/usr/bin/env python3
"""Bundle EVM chain logos into the extension.

Picks the built-in chains plus every mainnet on chainlist.org that holds value, finds each logo on
icons.llamao.fi (by chainlist icon, slug or short name), and writes 64x64 WebP files to
public/chains/evm/<slug>.webp with an index at src/data/evm/chainLogos.json (chain id -> slug).
Chains sharing a logo share the file. Chains without one fall back to a monogram in the UI, so
the extension never loads a chain logo from the network at runtime.

Run from the repo root: python3 scripts/sync-chain-logos.py   (needs Pillow with WebP)
"""
import hashlib
import io
import json
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
LOGOS = ROOT / "public" / "chains" / "evm"
INDEX = ROOT / "src" / "data" / "evm" / "chainLogos.json"
CHAINLIST = "https://chainlist.org/rpcs.json"
ICON = "https://icons.llamao.fi/icons/chains/rsz_{}.jpg"
BUILT_IN = {1, 4663}
SIZE = 64


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "0xio-extension logo sync"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def candidates(chain):
    icon = chain.get("icon") if isinstance(chain.get("icon"), str) else None
    names = (icon, chain.get("chainSlug"), (chain.get("shortName") or "").lower())
    return list(dict.fromkeys(n for n in names if n))


def fetch_logo(chain):
    for name in candidates(chain):
        try:
            raw = get(ICON.format(name))
        except Exception:
            continue
        if len(raw) < 200:
            continue
        try:
            img = Image.open(io.BytesIO(raw)).convert("RGBA")
        except Exception:
            continue
        return chain["chainId"], name, img
    return chain["chainId"], None, None


def main():
    chains = json.loads(get(CHAINLIST))
    pick = [c for c in chains if c["chainId"] in BUILT_IN or (not c.get("isTestnet") and (c.get("tvl") or 0) > 0)]
    pick.sort(key=lambda c: (c["chainId"] not in BUILT_IN, -(c.get("tvl") or 0)))
    with ThreadPoolExecutor(12) as pool:
        found = list(pool.map(fetch_logo, pick))

    LOGOS.mkdir(parents=True, exist_ok=True)
    INDEX.parent.mkdir(parents=True, exist_ok=True)
    for old in LOGOS.glob("*.webp"):
        old.unlink()

    by_chain, logos = {}, {}
    for chain_id, slug, img in found:
        if not slug:
            continue
        by_chain[str(chain_id)] = slug
        if slug in logos:
            continue
        img = img.resize((SIZE, SIZE), Image.LANCZOS)
        out = io.BytesIO()
        img.save(out, "WEBP", quality=86, method=6)
        data = out.getvalue()
        (LOGOS / f"{slug}.webp").write_bytes(data)
        logos[slug] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()[:16], "from": ICON.format(slug)}

    missing = [c["chainId"] for c in pick if str(c["chainId"]) not in by_chain]
    INDEX.write_text(json.dumps({
        "meta": {
            "source": "chainlist.org/rpcs.json + icons.llamao.fi",
            "generated": date.today().isoformat(),
            "size": SIZE,
            "path": "chains/evm/{slug}.webp",
        },
        "chains": dict(sorted(by_chain.items(), key=lambda kv: int(kv[0]))),
        "files": dict(sorted(logos.items())),
        "missing": sorted(missing),
    }, indent=2) + "\n")
    total = sum(v["bytes"] for v in logos.values())
    print(f"{len(by_chain)} chains, {len(logos)} logo files, {total // 1024} KB, {len(missing)} without a logo")


if __name__ == "__main__":
    main()
