' CCUI-Launcher: silent bootstrap for manager.ps1
' Runs PowerShell hidden, then exits immediately. No windows ever appear.

Set sh = CreateObject("WScript.Shell")
scriptDir = Replace(WScript.ScriptFullName, "\" & WScript.ScriptName, "")
ps1 = scriptDir & "\manager.ps1"

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """"
sh.Run cmd, 0, False
