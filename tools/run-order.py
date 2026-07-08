#!/usr/bin/env python3
"""Hexa Studio order runner: the background brain's executable half.

Takes an order payload (the JSON the studio UI writes to localStorage /
hands to intake), researches the product, composes optimized generation
params from catalog/recipes.json, prices the job, and (only with --live)
runs it on Higgsfield and downloads the result.

Default is a DRY RUN: research + composed params + cost, no credits spent.

Usage:
  python3 tools/run-order.py order.json                 # dry run
  python3 tools/run-order.py order.json --live          # generate for real
  python3 tools/run-order.py order.json --photo a.jpg   # attach local photos

The prompt in the dry-run output is the recipe skeleton merged with order
facts. In concierge mode Claude (the operator) does the final rewrite pass
guided by recipe['brain'] before --live; the future API backend calls
Claude with the same recipe fields.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RECIPES = json.loads((ROOT / "catalog" / "recipes.json").read_text())
STUDIO = json.loads((ROOT / "catalog" / "studio-data.json").read_text())


def sh(args, timeout=600):
    """Run a higgsfield CLI command, return parsed JSON (or raw text)."""
    proc = subprocess.run(["higgsfield", *args, "--json"],
                          capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(f"higgsfield {' '.join(args)} failed: {proc.stderr.strip() or proc.stdout.strip()}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return proc.stdout.strip()


def lookup(kind, sel_id):
    for item in STUDIO.get(kind, []):
        if item["id"] == sel_id:
            return item
    return {}


def research_product(sel):
    """Turn whatever the customer gave us into product facts."""
    facts = {"title": None, "summary": None, "web_product_id": None, "medias": [], "source": None}

    link = sel.get("link")
    if link:
        print(f"→ researching link via Higgsfield: {link}")
        wp = sh(["marketing-studio", "webproducts", "fetch", "--url", link, "--wait"])
        if wp.get("fail_reason"):
            print(f"  ! fetch failed: {wp['fail_reason']} (falling back to description/photos)")
        else:
            facts.update(title=wp.get("title"), web_product_id=wp.get("id"),
                         medias=wp.get("medias", []), source="link")
            print(f"  ✓ imported: {facts['title']} ({len(facts['medias'])} captures)")

    if sel.get("desc"):
        facts["summary"] = sel["desc"]
        facts["source"] = facts["source"] or "description"

    if not facts["summary"]:
        facts["summary"] = facts["title"] or "the customer's product"
    return facts


def compose(order, facts, photo_ids):
    """Merge order + facts into engine, params, and the prompt skeleton."""
    product = order["product"]
    mode_id = product.split(":", 1)[1] if product.startswith("mode:") else product
    recipe = RECIPES["recipes"].get(mode_id)
    if not recipe:
        raise SystemExit(f"no recipe for '{mode_id}'")

    sel = order.get("selections", {})
    avatar = sel.get("avatar") or {}
    hook = lookup("hooks", (sel.get("hook") or {}).get("id", ""))
    setting = sel.get("setting") or {}

    prompt = recipe["prompt_template"].format(
        avatar_name=avatar.get("name", "a natural creator"),
        hook_prompt=(hook.get("prompt") or "").strip(),
        setting_name=setting.get("name", "a fitting real-world scene"),
        product_summary=facts["summary"],
        shoot_mode=(sel.get("mode") or {}).get("name", "studio"),
        format_name=", ".join(f["name"] for f in sel.get("formats", [])) or "selected",
        camera=sel.get("camera", ""), grade=sel.get("grade", ""), light=sel.get("light", ""),
    ).strip()
    # Hexa style preset seed (art direction) rides ahead of the shared rules.
    style_seed = sel.get("styleSeed")
    if style_seed:
        prompt = (prompt + " " + style_seed).strip() if prompt else style_seed
    if prompt:
        prompt += " " + " ".join(RECIPES["shared_style"])

    params = dict(recipe["params"])
    if sel.get("aspect"):
        params["aspect_ratio"] = sel["aspect"]
    for key, val in (("camera_style", sel.get("camera")), ("color_grading", sel.get("grade")),
                     ("light_scheme", sel.get("light"))):
        if val and mode_id in ("cinematic", "tv_spot"):
            params[key] = val
    if avatar.get("id"):
        params["avatar_ids"] = [avatar["id"]]
    if hook.get("id"):
        params["hook_id"] = hook["id"]
    if setting.get("id"):
        params["setting_id"] = setting["id"]
    if facts["web_product_id"]:
        params["web_product_ids"] = [facts["web_product_id"]]
        params.setdefault("specific_mode", "web_product")
    if photo_ids:
        params["image_references"] = photo_ids

    return recipe, mode_id, prompt, params


def estimate(recipe, params):
    engine = recipe["engine"]
    if engine.startswith("workflow:") or ":" not in engine:
        target = engine.split(":", 1)[-1]
        args = ["generate", "cost", target, "--prompt", "cost probe"]
        for key in ("duration", "resolution", "specific_mode", "mode"):
            if key in params:
                args += [f"--{key.replace('_', '-')}", str(params[key])]
        try:
            return sh(args)
        except Exception as e:
            return f"(cost unavailable: {e})"
    return "(priced per sub-job)"


def main():
    argv = sys.argv[1:]
    if not argv:
        raise SystemExit(__doc__)
    live = "--live" in argv
    photos = [argv[i + 1] for i, a in enumerate(argv) if a == "--photo"]
    order_path = argv[0]
    order = json.loads(Path(order_path).read_text())

    style = order.get("style")
    print(f"── order: {order.get('title')}{' · ' + style if style else ''} (${order.get('price')}) ──")
    sel = order.get("selections", {})

    photo_ids = []
    if live:
        for p in photos:
            up = sh(["upload", "create", p])
            photo_ids.append(up.get("id") or up)
            print(f"  ✓ uploaded {p}")
    elif photos:
        print(f"→ {len(photos)} photo(s) will upload on --live")

    facts = research_product(sel)
    recipe, mode_id, prompt, params = compose(order, facts, photo_ids)

    print(f"\nengine : {recipe['engine']}")
    print(f"recipe : {mode_id}")
    print(f"params : {json.dumps({k: v for k, v in params.items() if k != 'image_references'}, indent=2)}")
    print(f"\nprompt skeleton:\n  {prompt}\n")
    print(f"brain notes (final rewrite pass): {recipe['brain']}")
    print(f"\nestimated cost: {estimate(recipe, params)}")

    if not live:
        print("\nDRY RUN complete. Re-run with --live to generate.")
        return

    engine = recipe["engine"]
    if engine.startswith("workflow:"):
        args = ["generate", "workflow", engine.split(":", 1)[1], "--prompt", prompt]
    elif engine == "product-photoshoot":
        args = ["product-photoshoot", "create", "--prompt", prompt]
    elif engine == "marketing-studio:dtc-ads":
        raise SystemExit("adpack runs one dtc-ads generate per format; drive those individually")
    elif engine == "soul-id":
        raise SystemExit("soul training needs reference photos via: higgsfield soul-id create")
    else:
        args = ["generate", "create", engine, "--prompt", prompt]

    for key, val in params.items():
        flag = "--" + key.replace("_", "-")
        if isinstance(val, list):
            for v in val:
                args += [flag, str(v)]
        elif isinstance(val, bool):
            if val:
                args += [flag]
        else:
            args += [flag, str(val)]

    print("\n→ creating job...")
    job = sh(args, timeout=120)
    job_id = job.get("id") if isinstance(job, dict) else str(job)
    print(f"  job: {job_id}")
    print("→ waiting for completion...")
    done = sh(["generate", "wait", job_id], timeout=1800)
    out = json.dumps(done, indent=2) if isinstance(done, dict) else str(done)
    print(out)

    results_dir = ROOT / "orders" / "results"
    results_dir.mkdir(parents=True, exist_ok=True)
    stamp = re.sub(r"[^0-9]", "", order.get("ts", ""))[:14] or "manual"
    (results_dir / f"{stamp}-{mode_id}.json").write_text(out)
    print(f"saved → orders/results/{stamp}-{mode_id}.json")


if __name__ == "__main__":
    main()
