"""
Export empties from a Blender scene as spawn() calls for Barrage level definitions.

Usage:
  1. Place empties in Blender named after template paths (e.g. "trebuchets/basic")
  2. Set optional custom properties on each empty:
     - player: 1 or 2
  3. Run this script in Blender (Scripting tab → Open → Run Script)
  4. Output appears in a "spawns" text block in the Text Editor

Blender duplicates (e.g. "missiles/basic.001") are stripped to the base name.
Coordinates: Blender Z-up → Babylon Y-up  (X stays, Z→Y, Y→Z).
Rotation: Blender local Y rotation → Babylon rotation (degrees).
"""

import bpy
import re
from math import degrees


def strip_blender_suffix(name):
    return re.sub(r'\.\d{3,}$', '', name)


def round_if_close(val, decimals=2):
    rounded = round(val, decimals)
    if rounded == int(rounded):
        return int(rounded)
    return rounded


def build_spawn_line(name, opts):
    parts = []
    for key in ("x", "y", "z", "rotation", "player"):
        if key in opts:
            parts.append(f"{key}: {opts[key]}")
    opts_str = ", ".join(parts)
    return f'    spawn("{name}", {{ {opts_str} }});'


def export_spawns():
    empties = [obj for obj in bpy.context.scene.objects if obj.type == 'EMPTY']

    if not empties:
        print("No empties found in the scene.")
        return

    lines = []
    for obj in sorted(empties, key=lambda o: o.name):
        name = strip_blender_suffix(obj.name)
        loc = obj.location
        rot = obj.rotation_euler

        opts = {}

        x = round_if_close(loc.x)
        y = round_if_close(loc.z)  # Blender Z → Babylon Y
        z = round_if_close(loc.y)  # Blender Y → Babylon Z

        if x != 0:
            opts["x"] = x
        if y != 0:
            opts["y"] = y
        if z != 0:
            opts["z"] = z

        rot_deg = round_if_close(degrees(rot.y))  # Blender Y rot → Babylon rotation
        if rot_deg != 0:
            opts["rotation"] = rot_deg

        player = obj.get("player")
        if player is not None:
            opts["player"] = int(player)

        lines.append(build_spawn_line(name, opts))

    output = "\n".join(lines)

    text_name = "spawns"
    if text_name in bpy.data.texts:
        bpy.data.texts.remove(bpy.data.texts[text_name])
    text_block = bpy.data.texts.new(text_name)
    text_block.write(output)

    print(f"\n--- {len(lines)} spawn calls → Text Editor: '{text_name}' ---\n")
    print(output)


export_spawns()
