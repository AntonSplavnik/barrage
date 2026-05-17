bl_info = {
    "name": "Quick Export",
    "blender": (3, 0, 0),
    "category": "Import-Export",
}

import bpy
from bpy.props import StringProperty

# ── Format detection from filepath ────────────────────────────────────
def detect_format(path):
    path = path.lower()
    if path.endswith('.fbx'):   return 'FBX'
    if path.endswith('.glb') or path.endswith('.gltf'): return 'GLTF'
    if path.endswith('.obj'):   return 'OBJ'
    return 'FBX'

# ── Post-save handler: runs after any export ───────────────────────────
def on_save_post(dummy):
    # Not relevant here, used for blend saves
    pass

# ── Wrap export operators to capture the path ──────────────────────────
_original_fbx_execute  = None
_original_gltf_execute = None
_original_obj_execute  = None

def make_wrapper(original_execute, fmt):
    def wrapper(self, context):
        result = original_execute(self, context)
        if 'FINISHED' in result:
            path = getattr(self, 'filepath', None)
            if path:
                context.scene["quick_export_path"]   = path
                context.scene["quick_export_format"] = fmt
        return result
    return wrapper

# ── Quick export operator ──────────────────────────────────────────────
FORMAT_ITEMS = [('FBX', 'FBX', ''), ('GLTF', 'glTF', ''), ('OBJ', 'OBJ', '')]

class EXPORT_OT_quick(bpy.types.Operator):
    bl_idname = "export.quick"
    bl_label = "Quick Export"

    def execute(self, context):
        scene = context.scene
        path = scene.get("quick_export_path", "")
        fmt  = scene.get("quick_export_format", "FBX")

        if not path:
            self.report({'WARNING'}, "No export path set — export manually once first")
            return {'CANCELLED'}

        if fmt == 'FBX':
            bpy.ops.export_scene.fbx(filepath=path, use_selection=False)
        elif fmt == 'GLTF':
            bpy.ops.export_scene.gltf(filepath=path)
        elif fmt == 'OBJ':
            bpy.ops.wm.obj_export(filepath=path)

        self.report({'INFO'}, f"Exported to {path}")
        return {'FINISHED'}

# ── Set path via file browser ──────────────────────────────────────────
class EXPORT_OT_set_path(bpy.types.Operator):
    bl_idname = "export.set_path"
    bl_label = "Set Export Path"
    filepath: StringProperty(subtype='FILE_PATH')

    def execute(self, context):
        context.scene["quick_export_path"]   = self.filepath
        context.scene["quick_export_format"] = detect_format(self.filepath)
        return {'FINISHED'}

    def invoke(self, context, event):
        context.window_manager.fileselect_add(self)
        return {'RUNNING_MODAL'}

# ── Set format operator ────────────────────────────────────────────────
class EXPORT_OT_set_format(bpy.types.Operator):
    bl_idname = "export.set_format"
    bl_label = "Set Format"
    format: StringProperty()

    def execute(self, context):
        context.scene["quick_export_format"] = self.format
        return {'FINISHED'}

# ── Panel ──────────────────────────────────────────────────────────────
class EXPORT_PT_quick_panel(bpy.types.Panel):
    bl_label = "Quick Export"
    bl_idname = "EXPORT_PT_quick_panel"
    bl_space_type = 'PROPERTIES'
    bl_region_type = 'WINDOW'
    bl_context = "output"

    def draw(self, context):
        layout = self.layout
        scene  = context.scene
        path = scene.get("quick_export_path", "")
        fmt  = scene.get("quick_export_format", "FBX")

        layout.label(text="Format:")
        row = layout.row(align=True)
        for id, label, _ in FORMAT_ITEMS:
            op = row.operator("export.set_format", text=label, depress=(fmt == id))
            op.format = id

        layout.separator()
        layout.label(text="Export Path:")
        row = layout.row(align=True)
        row.label(text=path if path else "(export manually once to set)", icon='FILE')
        row.operator("export.set_path", text="", icon='FILEBROWSER')

        layout.separator()
        layout.operator("export.quick", text="Export Now  [Ctrl+Shift+E]", icon='EXPORT')

# ── Registration ───────────────────────────────────────────────────────
classes = (
    EXPORT_OT_quick,
    EXPORT_OT_set_path,
    EXPORT_OT_set_format,
    EXPORT_PT_quick_panel,
)

addon_keymaps = []

def register():
    global _original_fbx_execute, _original_gltf_execute, _original_obj_execute

    for cls in classes:
        bpy.utils.register_class(cls)

    # Patch FBX
    fbx = bpy.types.EXPORT_SCENE_OT_fbx
    _original_fbx_execute = fbx.execute
    fbx.execute = make_wrapper(fbx.execute, 'FBX')

    # Patch glTF
    try:
        gltf = bpy.types.EXPORT_SCENE_OT_gltf
        _original_gltf_execute = gltf.execute
        gltf.execute = make_wrapper(gltf.execute, 'GLTF')
    except AttributeError:
        pass  # glTF addon not enabled

    # Patch OBJ
    try:
        obj = bpy.types.WM_OT_obj_export
        _original_obj_execute = obj.execute
        obj.execute = make_wrapper(obj.execute, 'OBJ')
    except AttributeError:
        pass  # OBJ exporter not available

    # Keymap
    wm = bpy.context.window_manager
    kc = wm.keyconfigs.addon
    if kc:
        km = kc.keymaps.new(name='Window', space_type='EMPTY')
        kmi = km.keymap_items.new("export.quick", 'E', 'PRESS', ctrl=True, shift=True)
        addon_keymaps.append((km, kmi))

def unregister():
    global _original_fbx_execute, _original_gltf_execute, _original_obj_execute

    # Restore original execute methods
    if _original_fbx_execute:
        bpy.types.EXPORT_SCENE_OT_fbx.execute = _original_fbx_execute
    if _original_gltf_execute:
        try:
            bpy.types.EXPORT_SCENE_OT_gltf.execute = _original_gltf_execute
        except AttributeError:
            pass
    if _original_obj_execute:
        try:
            bpy.types.WM_OT_obj_export.execute = _original_obj_execute
        except AttributeError:
            pass

    for km, kmi in addon_keymaps:
        km.keymap_items.remove(kmi)
    addon_keymaps.clear()

    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)