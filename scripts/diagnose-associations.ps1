#Requires -Version 5.1
<#
Read-only diagnostics for Kaleido's Windows file associations. Writes nothing to the registry.
Probes (independent layers of evidence, none of them "the picker database"):
  1. Stored registrations in HKCU and HKLM Classes (where each value really lives).
  2. AssocQueryString on the fixed Kaleido ProgID (ASSOCF_INIT_FIXED_PROGID | INIT_FOR_FILE | NOFIXUPS).
  3. IApplicationAssociationRegistration::QueryCurrentDefault (AT_FILEEXTENSION, AL_EFFECTIVE).
  4. SHAssocEnumHandlers with ASSOC_FILTER_NONE and ASSOC_FILTER_RECOMMENDED.
  5. The shell's "Open with" submenu (OpenWithMenu COM object, the one Explorer and Files use).
  6. With -PickerDialog: the modern "Choose an app" dialog (OpenWith.exe) for -File, read through
     UI Automation and closed again. Nothing in it is clicked, so no default can change.
#>
[CmdletBinding()]
param(
    [string]$File = (Join-Path $env:USERPROFILE 'Videos\kaleido-m0\sdr-1080p.mkv'),
    [string]$ProgId = 'Kaleido.M0.Video',
    [string[]]$Extensions = @('.mkv', '.mp4', '.avi', '.webm', '.mov', '.ts', '.m2ts', '.wmv'),
    [switch]$PickerDialog
)
$ErrorActionPreference = 'Stop'

if (-not ('KaleidoDiag.Probe' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace KaleidoDiag {
    [ComImport, Guid("4e530b0a-e611-4c77-a3ac-9031d022281b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IApplicationAssociationRegistration {
        [PreserveSig] int QueryCurrentDefault([MarshalAs(UnmanagedType.LPWStr)] string query, int type, int level, out IntPtr association);
    }
    [ComImport, Guid("591209c7-767b-42b2-9fba-44ee4615f2c7")] class ApplicationAssociationRegistration { }

    // Only the read-only methods are declared; MakeDefault/Invoke are never called.
    [ComImport, Guid("F04061AC-1659-4a3f-A954-775AA57FC083"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAssocHandler {
        [PreserveSig] int GetName(out IntPtr name);
        [PreserveSig] int GetUIName(out IntPtr name);
        [PreserveSig] int GetIconLocation(out IntPtr path, out int index);
        [PreserveSig] int IsRecommended();
    }
    [ComImport, Guid("973810ae-9599-4b88-9e4d-6ee98c9552da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IEnumAssocHandlers {
        [PreserveSig] int Next(uint celt, [MarshalAs(UnmanagedType.Interface)] out IAssocHandler handler, out uint fetched);
    }

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem {
        [PreserveSig] int BindToHandler(IntPtr bindCtx, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    }
    [ComImport, Guid("000214e8-0000-0000-c000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellExtInit {
        [PreserveSig] int Initialize(IntPtr pidlFolder, IntPtr dataObject, IntPtr hkeyProgId);
    }
    [ComImport, Guid("000214f4-0000-0000-c000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IContextMenu2 {
        [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint indexMenu, uint idCmdFirst, uint idCmdLast, uint flags);
        [PreserveSig] int InvokeCommand(IntPtr info);
        [PreserveSig] int GetCommandString(UIntPtr idCmd, uint type, IntPtr reserved, IntPtr name, uint cch);
        [PreserveSig] int HandleMenuMsg(uint msg, IntPtr wParam, IntPtr lParam);
    }
    [ComImport, Guid("09799AFB-AD67-11d1-ABCD-00C04FC30936")] class OpenWithMenu { }

    public static class Probe {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern int SHAssocEnumHandlers(string extension, int filter, out IEnumAssocHandlers handlers);
        [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
        static extern int AssocQueryStringW(int flags, int str, string assoc, string extra, StringBuilder output, ref uint length);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern int SHCreateItemFromParsingName(string path, IntPtr bindCtx, ref Guid riid, out IShellItem item);
        [DllImport("user32.dll")] static extern IntPtr CreatePopupMenu();
        [DllImport("user32.dll")] static extern bool DestroyMenu(IntPtr menu);
        [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr menu);
        [DllImport("user32.dll")] static extern IntPtr GetSubMenu(IntPtr menu, int pos);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern int GetMenuStringW(IntPtr menu, uint item, StringBuilder text, int max, uint flags);

        const int ASSOCF_NOFIXUPS = 0x100, ASSOCF_INIT_FIXED_PROGID = 0x800, ASSOCF_INIT_FOR_FILE = 0x2000;
        const uint WM_INITMENUPOPUP = 0x0117, MF_BYPOSITION = 0x400;

        static string Hr(int hr) { return string.Format("HRESULT 0x{0:X8}", hr); }
        static string Take(IntPtr p) {
            if (p == IntPtr.Zero) return null;
            string s = Marshal.PtrToStringUni(p);
            Marshal.FreeCoTaskMem(p);
            return s;
        }

        public static string FixedProgId(string progId, int what) {
            uint len = 2048;
            var sb = new StringBuilder((int)len);
            int hr = AssocQueryStringW(ASSOCF_INIT_FIXED_PROGID | ASSOCF_INIT_FOR_FILE | ASSOCF_NOFIXUPS, what, progId, null, sb, ref len);
            return hr == 0 ? sb.ToString() : Hr(hr);
        }

        public static string CurrentDefault(string extension) {
            var reg = (IApplicationAssociationRegistration)new ApplicationAssociationRegistration();
            IntPtr p;
            int hr = reg.QueryCurrentDefault(extension, 0 /* AT_FILEEXTENSION */, 1 /* AL_EFFECTIVE */, out p);
            Marshal.ReleaseComObject(reg);
            return hr == 0 ? Take(p) : Hr(hr);
        }

        public static List<string> Handlers(string extension, bool recommendedOnly) {
            var list = new List<string>();
            IEnumAssocHandlers e;
            int hr = SHAssocEnumHandlers(extension, recommendedOnly ? 1 : 0, out e);
            if (hr != 0) { list.Add(Hr(hr)); return list; }
            IAssocHandler h;
            uint fetched;
            while (e.Next(1, out h, out fetched) == 0 && fetched == 1) {
                IntPtr name, uiName, icon;
                int index;
                h.GetName(out name);
                h.GetUIName(out uiName);
                h.GetIconLocation(out icon, out index);
                Take(icon);
                list.Add(string.Format("{0} | {1}{2}", Take(uiName), Take(name), h.IsRecommended() == 0 ? " | recommended" : ""));
                Marshal.ReleaseComObject(h);
            }
            Marshal.ReleaseComObject(e);
            return list;
        }

        // Builds the shell's Open with submenu for one file and returns its item texts.
        public static List<string> OpenWithSubmenu(string path) {
            var items = new List<string>();
            Guid iidItem = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
            IShellItem item;
            int hr = SHCreateItemFromParsingName(path, IntPtr.Zero, ref iidItem, out item);
            if (hr != 0) { items.Add(Hr(hr)); return items; }
            Guid bhidDataObject = new Guid("B8C0BD9F-ED24-455c-83E6-D5390C4FE8C4");
            Guid iidDataObject = new Guid("0000010e-0000-0000-C000-000000000046");
            IntPtr dataObject;
            hr = item.BindToHandler(IntPtr.Zero, ref bhidDataObject, ref iidDataObject, out dataObject);
            if (hr != 0) { items.Add(Hr(hr)); return items; }
            object menuObject = new OpenWithMenu();
            var init = (IShellExtInit)menuObject;
            var menu2 = (IContextMenu2)menuObject;
            IntPtr menu = CreatePopupMenu();
            try {
                hr = init.Initialize(IntPtr.Zero, dataObject, IntPtr.Zero);
                if (hr != 0) { items.Add("Initialize " + Hr(hr)); return items; }
                hr = menu2.QueryContextMenu(menu, 0, 1, 0x7FFF, 0 /* CMF_NORMAL */);
                if (hr < 0) { items.Add("QueryContextMenu " + Hr(hr)); return items; }
                for (int i = 0; i < GetMenuItemCount(menu); i++) {
                    IntPtr sub = GetSubMenu(menu, i);
                    if (sub == IntPtr.Zero) { items.Add(MenuText(menu, i)); continue; }
                    menu2.HandleMenuMsg(WM_INITMENUPOPUP, sub, (IntPtr)i);
                    for (int j = 0; j < GetMenuItemCount(sub); j++) items.Add(MenuText(sub, j));
                }
            } finally {
                DestroyMenu(menu);
                Marshal.Release(dataObject);
                Marshal.ReleaseComObject(menuObject);
                Marshal.ReleaseComObject(item);
            }
            return items;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
        struct CMINVOKECOMMANDINFO {
            public int cbSize; public int fMask; public IntPtr hwnd; public IntPtr lpVerb;
            public string lpParameters; public string lpDirectory; public int nShow;
            public int dwHotKey; public IntPtr hIcon;
        }
        [DllImport("user32.dll")] static extern uint GetMenuItemID(IntPtr menu, int pos);

        // Opens the "Choose another app" dialog exactly as Explorer's submenu does. It only
        // shows the dialog; nothing inside it is selected.
        public static string ChooseAnotherApp(string path) { return ChooseAnotherApp(path, IntPtr.Zero); }

        public static string ChooseAnotherApp(string path, IntPtr owner) {
            Guid iidItem = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
            IShellItem item;
            int hr = SHCreateItemFromParsingName(path, IntPtr.Zero, ref iidItem, out item);
            if (hr != 0) return Hr(hr);
            Guid bhidDataObject = new Guid("B8C0BD9F-ED24-455c-83E6-D5390C4FE8C4");
            Guid iidDataObject = new Guid("0000010e-0000-0000-C000-000000000046");
            IntPtr dataObject;
            hr = item.BindToHandler(IntPtr.Zero, ref bhidDataObject, ref iidDataObject, out dataObject);
            if (hr != 0) return Hr(hr);
            object menuObject = new OpenWithMenu();
            var menu2 = (IContextMenu2)menuObject;
            IntPtr menu = CreatePopupMenu();
            try {
                ((IShellExtInit)menuObject).Initialize(IntPtr.Zero, dataObject, IntPtr.Zero);
                menu2.QueryContextMenu(menu, 0, 1, 0x7FFF, 0);
                for (int i = 0; i < GetMenuItemCount(menu); i++) {
                    IntPtr sub = GetSubMenu(menu, i);
                    if (sub == IntPtr.Zero) continue;
                    menu2.HandleMenuMsg(WM_INITMENUPOPUP, sub, (IntPtr)i);
                    int last = GetMenuItemCount(sub) - 1;          // "Choose another app" is the last item
                    uint id = GetMenuItemID(sub, last);
                    var info = new CMINVOKECOMMANDINFO();
                    info.cbSize = Marshal.SizeOf(typeof(CMINVOKECOMMANDINFO));
                    info.lpVerb = (IntPtr)(id - 1);                // offset from idCmdFirst = 1
                    info.hwnd = owner;
                    info.nShow = 1;
                    IntPtr p = Marshal.AllocHGlobal(info.cbSize);
                    try {
                        Marshal.StructureToPtr(info, p, false);
                        return "invoked '" + MenuText(sub, last) + "': " + Hr(menu2.InvokeCommand(p));
                    } finally { Marshal.FreeHGlobal(p); }
                }
                return "no Open with submenu";
            } finally {
                DestroyMenu(menu);
                Marshal.Release(dataObject);
                Marshal.ReleaseComObject(menuObject);
                Marshal.ReleaseComObject(item);
            }
        }

        [ComImport, Guid("000214e4-0000-0000-c000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IContextMenu {
            [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint indexMenu, uint idCmdFirst, uint idCmdLast, uint flags);
        }

        // Top-level items of the shell's classic context menu for one file (what "Show more
        // options" renders), built from the registry by Windows itself, independent of any
        // menu replacement such as Nilesoft.
        public static List<string> ClassicMenu(string path) {
            var items = new List<string>();
            Guid iidItem = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
            IShellItem item;
            int hr = SHCreateItemFromParsingName(path, IntPtr.Zero, ref iidItem, out item);
            if (hr != 0) { items.Add(Hr(hr)); return items; }
            Guid bhidSfui = new Guid("3981e225-f559-11d3-8e3a-00c04f6837d5");
            Guid iidMenu = new Guid("000214e4-0000-0000-c000-000000000046");
            IntPtr pMenu;
            hr = item.BindToHandler(IntPtr.Zero, ref bhidSfui, ref iidMenu, out pMenu);
            if (hr != 0) { items.Add(Hr(hr)); return items; }
            var menuObject = (IContextMenu)Marshal.GetObjectForIUnknown(pMenu);
            IntPtr menu = CreatePopupMenu();
            try {
                hr = menuObject.QueryContextMenu(menu, 0, 1, 0x7FFF, 0 /* CMF_NORMAL */);
                if (hr < 0) { items.Add("QueryContextMenu " + Hr(hr)); return items; }
                for (int i = 0; i < GetMenuItemCount(menu); i++) items.Add(MenuText(menu, i));
            } finally {
                DestroyMenu(menu);
                Marshal.ReleaseComObject(menuObject);
                Marshal.Release(pMenu);
                Marshal.ReleaseComObject(item);
            }
            return items;
        }

        static string MenuText(IntPtr menu, int pos) {
            var sb = new StringBuilder(512);
            GetMenuStringW(menu, (uint)pos, sb, sb.Capacity, MF_BYPOSITION);
            return sb.Length == 0 ? "(separator)" : sb.ToString().Replace("&", "");
        }
    }
}
'@
}

function Show-Values([string]$Hive, [string]$Path) {
    $key = $(if ($Hive -eq 'HKCU') { [Microsoft.Win32.Registry]::CurrentUser } else { [Microsoft.Win32.Registry]::LocalMachine }).OpenSubKey($Path)
    if (-not $key) { "  {0}\{1}: (missing)" -f $Hive, $Path; return }
    try {
        $names = @($key.GetValueNames())
        if ($names.Count -eq 0) { "  {0}\{1}: (no values)" -f $Hive, $Path }
        foreach ($n in $names) {
            "  {0}\{1} [{2}] ({3}) = {4}" -f $Hive, $Path, $(if ($n) { $n } else { '(Default)' }), $key.GetValueKind($n), $key.GetValue($n)
        }
    } finally { $key.Dispose() }
}

$v = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
"== System"
"Windows {0} build {1}.{2}; booted {3}; explorer started {4}" -f $v.DisplayVersion, $v.CurrentBuild, $v.UBR,
    (Get-CimInstance Win32_OperatingSystem).LastBootUpTime,
    (Get-Process explorer -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1).StartTime

"== 1. Stored registrations"
foreach ($hive in 'HKCU', 'HKLM') {
    Show-Values $hive "Software\Classes\$ProgId\shell\open\command"
    Show-Values $hive 'Software\Classes\Applications\Kaleido.exe'
    Show-Values $hive 'Software\Classes\Applications\Kaleido.exe\shell\open\command'
    Show-Values $hive 'Software\RegisteredApplications'
}
foreach ($ext in $Extensions) {
    Show-Values 'HKCU' "Software\Classes\$ext"
    Show-Values 'HKCU' "Software\Classes\$ext\OpenWithProgids"
}

"== 2. Fixed ProgID $ProgId"
"  command:  " + [KaleidoDiag.Probe]::FixedProgId($ProgId, 1)
"  exe:      " + [KaleidoDiag.Probe]::FixedProgId($ProgId, 2)
"  app name: " + [KaleidoDiag.Probe]::FixedProgId($ProgId, 4)

"== 3. Effective defaults (QueryCurrentDefault)"
foreach ($ext in $Extensions) { "  {0,-6} {1}" -f $ext, [KaleidoDiag.Probe]::CurrentDefault($ext) }

$sample = [IO.Path]::GetExtension($File)
"== 4. SHAssocEnumHandlers $sample"
"  -- all"
[KaleidoDiag.Probe]::Handlers($sample, $false) | ForEach-Object { "  $_" }
"  -- recommended"
[KaleidoDiag.Probe]::Handlers($sample, $true) | ForEach-Object { "  $_" }

"== 5. Shell Open with submenu for $File"
if (Test-Path -LiteralPath $File -PathType Leaf) {
    [KaleidoDiag.Probe]::OpenWithSubmenu((Resolve-Path -LiteralPath $File).ProviderPath) | ForEach-Object { "  $_" }
} else {
    "  (file not found)"
}

"== 7. Classic context menu for $File"
if (Test-Path -LiteralPath $File -PathType Leaf) {
    [KaleidoDiag.Probe]::ClassicMenu((Resolve-Path -LiteralPath $File).ProviderPath) |
        Where-Object { $_ -ne '(separator)' } | ForEach-Object { "  $_" }
}

if ($PickerDialog) {
    "== 6. Choose an app dialog (OpenWith.exe) for $File"
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $automation = [System.Windows.Automation.AutomationElement]
    # A small visible owner window: the picker refuses to appear for a caller without one.
    Add-Type -AssemblyName System.Windows.Forms
    $owner = New-Object System.Windows.Forms.Form
    $owner.Text = 'Kaleido association probe'
    $owner.Width = 320; $owner.Height = 80; $owner.TopMost = $true
    $owner.Show(); $owner.Activate(); [System.Windows.Forms.Application]::DoEvents()
    $before = @($automation::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object { $_.Current.NativeWindowHandle })
    "  " + [KaleidoDiag.Probe]::ChooseAnotherApp((Resolve-Path -LiteralPath $File).ProviderPath, $owner.Handle)
    $dialog = $null
    $deadline = (Get-Date).AddSeconds(15)
    while (-not $dialog -and (Get-Date) -lt $deadline) {
        for ($i = 0; $i -lt 6; $i++) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50 }
        # The dialog belongs to OpenWith.exe or a shell broker; never touch other apps' windows.
        foreach ($w in $automation::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,
                [System.Windows.Automation.Condition]::TrueCondition)) {
            if ($before -contains $w.Current.NativeWindowHandle) { continue }
            $ownerName = (Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName
            # Skip OpenWith's interim placeholder; the real picker window follows it.
            if ($w.Current.ClassName -like '*Dummy Window*') { continue }
            if ($ownerName -match '^(OpenWith|explorer|PickerHost|ShellHost|rundll32)$') { $dialog = $w; break }
        }
    }
    if (-not $dialog) {
        "  (no OpenWith.exe window appeared within 15 s)"
    } else {
        Start-Sleep -Seconds 2   # let the list finish populating
        "  window: '{0}' class {1}, process {2}" -f $dialog.Current.Name, $dialog.Current.ClassName,
            (Get-Process -Id $dialog.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName
        $items = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($el in $items) {
            $type = $el.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
            if ($el.Current.Name -and $type -in 'ListItem', 'Group', 'Text', 'Button', 'CheckBox', 'Hyperlink') {
                "  {0,-9} {1}" -f $type, $el.Current.Name
            }
        }
        $window = $null
        if ($dialog.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$window)) {
            $window.Close()
            "  (dialog closed without a selection)"
        } else {
            "  (dialog has no close pattern; close it by hand with Esc)"
        }
    }
    $owner.Close(); $owner.Dispose()
}
