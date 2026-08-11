' Roleplay Card Converter - one-click start
' ==========================================================================
' Starts the local server with no console window and opens the tool in your
' default browser. If it is already running (started at login, or by the
' VS Code task), the server notices, bows out, and the browser still opens.
'
' Double-click this file. Nothing to install.
'
'   /silent   start the server but do not open a browser tab. Used by the
'             Windows login shortcut, where a tab appearing at every logon
'             would be a nuisance.

Option Explicit

Dim shell, fso, here, nodeExe, cmd, openFlag, i
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)

' Accept several spellings: the Windows shortcut passes /silent, but some
' shells rewrite a leading slash into a path, so -silent and --silent work too.
Dim arg
openFlag = " --open"
For i = 0 To WScript.Arguments.Count - 1
    arg = LCase(WScript.Arguments(i))
    If Right(arg, 6) = "silent" Then openFlag = ""
Next
If WScript.Arguments.Named.Exists("silent") Then openFlag = ""

' Prefer the standard install path, fall back to whatever is on PATH.
nodeExe = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node"

cmd = """" & nodeExe & """ """ & here & "\proxy.js""" & openFlag

On Error Resume Next
' 0 = hidden window, False = do not wait for it to exit
shell.Run cmd, 0, False

' Report a failure only when started by hand. At login a popup would be a
' nuisance, and the tool already says "Proxy off" in its header when the
' server is not there, which is where the problem actually shows up.
If Err.Number <> 0 And openFlag <> "" Then
    MsgBox "Could not start the card converter." & vbCrLf & vbCrLf & _
           "Node.js does not appear to be installed, or is not on your PATH." & vbCrLf & _
           "Install it from https://nodejs.org and try again." & vbCrLf & vbCrLf & _
           "Details: " & Err.Description, 16, "Roleplay Card Converter"
End If
On Error Goto 0
