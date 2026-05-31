; "Open in Its Just Terminal" shell verbs for folders, folder backgrounds, and drives.
; HKCU matches installer currentUser scope. %V = clicked path.
; NoWorkingDirectory keeps Explorer from overriding %V (System32 on Drive).

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInItsJustTerminal" "" "Open in Its Just Terminal"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInItsJustTerminal" "Icon" '"$INSTDIR\its-just-terminal.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInItsJustTerminal" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInItsJustTerminal\command" "" '"$INSTDIR\its-just-terminal.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInItsJustTerminal" "" "Open in Its Just Terminal"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInItsJustTerminal" "Icon" '"$INSTDIR\its-just-terminal.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInItsJustTerminal" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInItsJustTerminal\command" "" '"$INSTDIR\its-just-terminal.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInItsJustTerminal" "" "Open in Its Just Terminal"
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInItsJustTerminal" "Icon" '"$INSTDIR\its-just-terminal.exe",0'
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInItsJustTerminal" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInItsJustTerminal\command" "" '"$INSTDIR\its-just-terminal.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInItsJustTerminal"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInItsJustTerminal"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInItsJustTerminal"
!macroend
