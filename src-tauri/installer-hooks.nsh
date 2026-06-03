; "Open in Termul" shell verbs for folders, folder backgrounds, and drives.
; HKCU matches installer currentUser scope. %V = clicked path.
; NoWorkingDirectory keeps Explorer from overriding %V (System32 on Drive).

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInTermul" "" "Open in Termul"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInTermul" "Icon" '"$INSTDIR\termul.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInTermul" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInTermul\command" "" '"$INSTDIR\termul.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInTermul" "" "Open in Termul"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInTermul" "Icon" '"$INSTDIR\termul.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInTermul" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInTermul\command" "" '"$INSTDIR\termul.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInTermul" "" "Open in Termul"
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInTermul" "Icon" '"$INSTDIR\termul.exe",0'
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInTermul" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInTermul\command" "" '"$INSTDIR\termul.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInTermul"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInTermul"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInTermul"
!macroend
