' Launches run.ps1 with no visible window.
'
' Task Scheduler runs our tasks as an interactive user (switching the principal to
' S4U, which would hide them, needs admin rights we do not have). powershell.exe
' -WindowStyle Hidden still flashes a console. WScript.Shell.Run with intWindowStyle=0
' never creates one, and needs no elevation.
'
' Usage:  wscript.exe run-hidden.vbs [-Collect|-Poll|...]

Dim shell, fso, here, cmd, i
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & here & "\run.ps1"""
For i = 0 To WScript.Arguments.Count - 1
  cmd = cmd & " " & WScript.Arguments(i)
Next

' 0 = hidden window. Must wait (True): if wscript exits first, Task Scheduler
' treats the task as finished and tears down the process tree, killing PowerShell
' mid-run. Waiting also lets the task's exit code reflect the real result.
WScript.Quit shell.Run(cmd, 0, True)
