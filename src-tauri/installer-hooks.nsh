; Rhine Music 安装钩子
;
; 为什么需要：NSIS 升级安装只会覆盖同名文件，**不会删除**新版本里已经没有的
; 旧文件。上一版删掉的音源 / 脚本就会一直留在 $INSTDIR\runtime 里，结果是
; 「默认音源」越装越多（实测 0.1.6 装出 109 个，而包内只有 20 个）。
;
; 所以在写入任何文件之前，先把整个 runtime 目录删掉，让新版从干净状态展开。
; runtime 是程序自己的资产（前端产物 + Node 运行时 + 脚本），用户数据在
; dataDir（music-data-v3 / AppData），删这里不会碰用户的音源与歌单。

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "重置运行时目录…"
  ; 程序若还开着，runtime 里的 node.exe / dll 被占用，RMDir 会删不干净。
  ; 安装程序本来就要先关掉应用，这里主动结束一次，确保目录能整体删除。
  ExecWait 'taskkill /f /im "${MAINBINARYNAME}.exe"' $0
  RMDir /r "$INSTDIR\runtime"
!macroend
