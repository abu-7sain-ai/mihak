' يشغّل كشّاف Fable بدون نافذة (Task Scheduler يستدعيه كل ربع ساعة)
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
node = fso.BuildPath(fso.GetParentFolderName(dir), "runtime\node.exe")
If Not fso.FileExists(node) Then node = "node"
CreateObject("WScript.Shell").Run """" & node & """ """ & fso.BuildPath(dir, "fable-runner.js") & """", 0, False
