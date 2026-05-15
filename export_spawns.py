"""
Export objects from "game_objects" collection as a Barrage level JS module.

Usage:
  1. Place objects in a collection named "game_objects"
  2. Name objects after template paths (e.g. "trebuchets/basic", "kings/default-L")
     - Objects with "bomb" in the name are spawned as "missiles/bomb"
     - Blender suffixes (.001, -ColVis, -Col, -Vis) are stripped automatically
  3. Optionally set a custom property "player" to 1 or 2 on any object
  4. Run in Blender (Scripting tab → Run Script)
  5. Output appears in a "level_output" text block in the Text Editor

Coordinates: Blender Z-up → Babylon Y-up  (X stays, Z→Y, Y→Z).
Rotation: Blender local Y rotation → Babylon rotation (degrees).
"""

import bpy
import re
from math import degrees

# --- Configure these for each level ---
ARENA = "levels/level1.glb"
LEVEL_FILE = "server/game/levels/level1.js"


def strip_blender_suffix(name):
    name = re.sub(r'\.\d{3,}$', '', name)                      # strip .001, .002 etc.
    name = re.sub(r'-(ColVis|Col|Vis)$', '', name, flags=re.IGNORECASE)  # strip physics mesh suffixes
    name = name.replace("defarult", "default")                  # fix typo
    return name


def side(name_lower):
    return "R" if ("right" in name_lower or name_lower.endswith("r")) else "L"


def name_to_template(name):
    lower = name.lower()
    if "bomb" in lower:
        return "missiles/bomb"
    if "king" in lower:
        return f"kings/default-{side(lower)}"
    if "trebuchet" in lower or "trebuche" in lower:
        return f"trebuchets/basic-{side(lower)}"
    if "missile" in lower:
        return "missiles/basic"
    if "block" in lower:
        return f"blocks/default-{side(lower)}"
    return name


def round_if_close(val, decimals=2):
    rounded = round(val, decimals)
    return int(rounded) if rounded == int(rounded) else rounded


def build_spawn_line(template, opts):
    parts = []
    for key in ("x", "y", "z", "rotation", "player", "shape", "fragmentTemplate"):
        if key not in opts:
            continue
        val = opts[key]
        parts.append(f'{key}: "{val}"' if isinstance(val, str) else f"{key}: {val}")
    if parts:
        return f'    spawn("{template}", {{ {", ".join(parts)} }});'
    return f'    spawn("{template}");'


def all_objects_in(collection):
    objects = set(collection.objects)
    for child in collection.children_recursive:
        objects.update(child.objects)
    return objects


def export_level():
    collection = bpy.data.collections.get("game_objects")
    if not collection:
        print("No collection named 'game_objects' found.")
        return

    all_objects = all_objects_in(collection)
    roots = sorted(
        (obj for obj in all_objects if obj.parent not in all_objects),
        key=lambda o: o.name,
    )

    spawn_lines = []
    for obj in roots:
        name = strip_blender_suffix(obj.name)
        template = name_to_template(name)

        loc = obj.location
        rot = obj.rotation_euler

        opts = {}
        x = round_if_close(loc.x)
        y = round_if_close(loc.z)   # Blender Z → Babylon Y
        z = round_if_close(loc.y)   # Blender Y → Babylon Z
        rot_deg = round_if_close(degrees(rot.y))

        if x != 0: opts["x"] = x
        if y != 0: opts["y"] = y
        if z != 0: opts["z"] = z
        if rot_deg != 0: opts["rotation"] = rot_deg

        player = obj.get("player")
        if player is not None:
            opts["player"] = int(player)

        if template.startswith("kings/"):
            opts["shape"] = "convex_hull"

        if template.startswith("blocks/"):
            opts["fragmentTemplate"] = template.replace("default", "fragmented")

        spawn_lines.append(build_spawn_line(template, opts))

    output = "\n".join([
        f"// {LEVEL_FILE}",
        "export default {",
        f'  arena: "{ARENA}",',
        "",
        "  setup(spawn) {",
        *spawn_lines,
        "  },",
        "};",
    ])

    text_name = "level_output"
    if text_name in bpy.data.texts:
        bpy.data.texts.remove(bpy.data.texts[text_name])
    bpy.data.texts.new(text_name).write(output)

    print(f"\n--- {len(spawn_lines)} spawn calls → Text Editor: '{text_name}' ---\n")
    print(output)


export_level()
