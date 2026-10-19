# FluxFetch setup: welcome/scope -> configuration -> progress -> ready.
!include "nsDialogs.nsh"
!include "WinMessages.nsh"
!include "UAC.nsh"
Var pid

!ifndef BUILD_UNINSTALLER
Var FluxFetchInstallScope
Var FluxFetchInstallAllUsers
Var FluxFetchInstallCurrentUser
Var FluxFetchChromeState
Var FluxFetchEdgeState
Var FluxFetchFirefoxState
Var FluxFetchStartupState
Var FluxFetchStartMenuState
Var FluxFetchStartupCheckbox
Var FluxFetchStartMenuCheckbox
Var FluxFetchFolder
Var FluxFetchRun
Var FluxFetchTitleFont
Var FluxFetchBodyFont
Var FluxFetchSmallFont
Var FluxFetchBoldFont
Var FluxFetchDpi
Var FluxFetchSavedFolder
Var FluxFetchFolderError
Var FluxFetchDesktopState
Var FluxFetchDesktopCheckbox
Var FluxFetchSpaceText
Var FluxFetchAdminHint
Var FluxFetchLicenseCheckbox
Var FluxFetchLicenseAccepted
Var FluxFetchFreshState
Var FluxFetchUpdateRadio
Var FluxFetchFreshRadio
!endif

!macro customInit
!ifndef BUILD_UNINSTALLER
  InitPluginsDir
  File /oname=$PLUGINSDIR\FluxFetchButtons.dll "${BUILD_RESOURCES_DIR}\FluxFetchButtons.dll"
  File /oname=$PLUGINSDIR\FluxFetch.ico "${BUILD_RESOURCES_DIR}\icon.ico"
  File /oname=$PLUGINSDIR\FluxFetch-license.txt "${BUILD_RESOURCES_DIR}\installer-license.txt"
  System::Call 'kernel32::LoadLibraryW(w "$PLUGINSDIR\FluxFetchButtons.dll")p .r0'
  StrCpy $FluxFetchChromeState ${BST_CHECKED}
  StrCpy $FluxFetchEdgeState ${BST_CHECKED}
  StrCpy $FluxFetchFirefoxState ${BST_CHECKED}
  StrCpy $FluxFetchStartupState ${BST_UNCHECKED}
  StrCpy $FluxFetchStartMenuState ${BST_CHECKED}
  StrCpy $FluxFetchDesktopState ${BST_CHECKED}
  StrCpy $FluxFetchSavedFolder ""
  StrCpy $FluxFetchInstallScope "current"
  ${if} $installMode == "all"
    StrCpy $FluxFetchInstallScope "all"
  ${endif}
  ClearErrors
  ReadRegDWORD $0 SHELL_CONTEXT "Software\FluxFetch\Installer" "ChromeIntegration"
  ${ifNot} ${Errors}
    StrCpy $FluxFetchChromeState $0
  ${endif}
  ClearErrors
  ReadRegDWORD $0 SHELL_CONTEXT "Software\FluxFetch\Installer" "EdgeIntegration"
  ${ifNot} ${Errors}
    StrCpy $FluxFetchEdgeState $0
  ${endif}
  ClearErrors
  ReadRegDWORD $0 SHELL_CONTEXT "Software\FluxFetch\Installer" "FirefoxIntegration"
  ${ifNot} ${Errors}
    StrCpy $FluxFetchFirefoxState $0
  ${endif}
  ReadRegStr $0 SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\Run" "FluxFetch"
  ${if} $0 != ""
    StrCpy $FluxFetchStartupState ${BST_CHECKED}
  ${endif}
  ClearErrors
  ReadRegDWORD $0 SHELL_CONTEXT "Software\FluxFetch\Installer" "StartMenuShortcut"
  ${ifNot} ${Errors}
    StrCpy $FluxFetchStartMenuState $0
  ${endif}
  ClearErrors
  ReadRegDWORD $0 SHELL_CONTEXT "Software\FluxFetch\Installer" "DesktopShortcut"
  ${ifNot} ${Errors}
    StrCpy $FluxFetchDesktopState $0
  ${endif}
  !ifdef FLUXFETCH_SETUP_PREVIEW
    # The design-only build can exercise every page without installing the app.
    SectionSetFlags 0 0
    StrCpy $FluxFetchInstallScope "current"
  !endif
!endif
!macroend

!macro customWelcomePage
  # Advance directly from successful extraction to our completion page.
  AutoCloseWindow true
  !ifdef FLUXFETCH_SETUP_PREVIEW
    Caption "FluxFetch Setup Preview"
  !endif
  BrandingText " "
  !define MUI_BGCOLOR "171925"
  !define MUI_TEXTCOLOR "F0F0FA"
  !define MUI_INSTFILESPAGE_COLORS "F0F0FA 202231"
  !define MUI_HEADER_TRANSPARENT_TEXT
  !define MUI_CUSTOMFUNCTION_GUIINIT FluxFetchGuiInit
  !insertmacro MUI_PAGE_INIT
  !insertmacro FluxFetchFunctions
  Page custom FluxFetchWelcome FluxFetchWelcomeLeave
  Page custom FluxFetchLicense FluxFetchLicenseLeave
!macroend

# electron-builder's mode page still owns elevation and install-directory resolution.
# Its UI is skipped; our welcome page supplies the choice.
!macro customInstallmode
!ifndef BUILD_UNINSTALLER
  !ifdef FLUXFETCH_SETUP_PREVIEW
    StrCpy $FluxFetchInstallScope "current"
  !endif
  ${if} $FluxFetchInstallScope == "all"
    StrCpy $isForceMachineInstall "1"
  ${else}
    StrCpy $isForceCurrentInstall "1"
  ${endif}
!endif
!macroend

!macro customPageAfterChangeDir
  Page custom FluxFetchInstallChoice FluxFetchInstallChoiceLeave
  Page custom FluxFetchConfigure FluxFetchConfigureLeave
  Page custom FluxFetchReview
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW FluxFetchProgressShow
!macroend

!macro customFinishPage
  Page custom FluxFetchReady FluxFetchReadyLeave
!macroend

!macro FluxLabel X Y W H TEXT COLOR
  ${NSD_CreateLabel} ${X} ${Y} ${W} ${H} "${TEXT}"
  Pop $0
  SetCtlColors $0 "${COLOR}" "171925"
  SendMessage $0 ${WM_SETFONT} $FluxFetchBodyFont 1
!macroend

# Pixel geometry scales with the same monitor DPI as the native dialog and fonts.
!macro FluxMove HWND X Y W H
  IntOp $R0 ${X} * $FluxFetchDpi
  IntOp $R0 $R0 / 96
  IntOp $R1 ${Y} * $FluxFetchDpi
  IntOp $R1 $R1 / 96
  IntOp $R2 ${W} * $FluxFetchDpi
  IntOp $R2 $R2 / 96
  IntOp $R3 ${H} * $FluxFetchDpi
  IntOp $R3 $R3 / 96
  System::Call 'user32::SetWindowPos(p ${HWND}, p 0, i $R0, i $R1, i $R2, i $R3, i 20)'
!macroend

!macro FluxCard Y H
  ${NSD_CreateLabel} 0 ${Y} 100% ${H} ""
  Pop $0
  SetCtlColors $0 "F0F0FA" "202231"
  # Keep the decorative surface behind focusable controls and their labels.
  System::Call 'user32::SetWindowPos(p $0, p 1, i 0, i 0, i 0, i 0, i 19)'
!macroend

!macro FluxFetchFunctions
Function FluxFetchInstallChoice
  !insertmacro MUI_HEADER_TEXT "INSTALLATION TYPE" "Choose how FluxFetch should be installed."
  nsDialogs::Create 1018
  Pop $0
  SetCtlColors $0 "F0F0FA" "171925"
  !insertmacro FluxLabel 0 0 100% 32u "Update or start fresh?" "F0F0FA"
  SendMessage $0 ${WM_SETFONT} $FluxFetchTitleFont 1
  !insertmacro FluxLabel 0 39u 100% 30u "Setup will close FluxFetch automatically before replacing its files.$\r$\nDownloaded files are kept with either choice." "A4A8C1"
  ${NSD_CreateRadioButton} 0 88u 100% 18u "Update (recommended)"
  Pop $FluxFetchUpdateRadio
  System::Call 'uxtheme::SetWindowTheme(p $FluxFetchUpdateRadio, w "", w "")'
  SetCtlColors $FluxFetchUpdateRadio "F0F0FA" "171925"
  SendMessage $FluxFetchUpdateRadio ${WM_SETFONT} $FluxFetchBoldFont 1
  !insertmacro FluxLabel 15u 110u 95% 22u "Keep this Windows account's settings, credentials and download history." "A4A8C1"
  ${NSD_CreateRadioButton} 0 143u 100% 18u "Fresh install"
  Pop $FluxFetchFreshRadio
  System::Call 'uxtheme::SetWindowTheme(p $FluxFetchFreshRadio, w "", w "")'
  SetCtlColors $FluxFetchFreshRadio "F0F0FA" "171925"
  SendMessage $FluxFetchFreshRadio ${WM_SETFONT} $FluxFetchBoldFont 1
  !insertmacro FluxLabel 15u 165u 95% 34u "Reset this Windows account's settings, saved credentials and history.$\r$\nYour downloaded files stay on disk." "A4A8C1"
  ${if} $FluxFetchFreshState == ${BST_CHECKED}
    ${NSD_Check} $FluxFetchFreshRadio
  ${else}
    ${NSD_Check} $FluxFetchUpdateRadio
  ${endif}
  GetDlgItem $0 $HWNDPARENT 1
  EnableWindow $0 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Continue"
  nsDialogs::Show
FunctionEnd

Function FluxFetchInstallChoiceLeave
  ${NSD_GetState} $FluxFetchFreshRadio $FluxFetchFreshState
FunctionEnd

Function FluxFetchLicense
  !insertmacro MUI_HEADER_TEXT "LICENSE AGREEMENT" "Review the terms for using FluxFetch."
  nsDialogs::Create 1018
  Pop $0
  SetCtlColors $0 "F0F0FA" "171925"
  !insertmacro FluxLabel 0 0 100% 30u "Made for your downloads." "F0F0FA"
  SendMessage $0 ${WM_SETFONT} $FluxFetchTitleFont 1
  !insertmacro FluxLabel 0 35u 100% 18u "FluxFetch  /  Hammad Ur Rehman" "A99AFF"
  FileOpen $0 "$PLUGINSDIR\FluxFetch-license.txt" r
  StrCpy $1 ""
  license_read:
    ClearErrors
    FileRead $0 $2
    IfErrors license_done
    StrCpy $1 "$1$2"
    Goto license_read
  license_done:
  FileClose $0
  nsDialogs::CreateControl "EDIT" "${WS_VISIBLE}|${WS_CHILD}|${WS_TABSTOP}|${WS_VSCROLL}|${ES_MULTILINE}|${ES_READONLY}|${ES_AUTOVSCROLL}" 0 0 57u 100% 104u "$1"
  Pop $0
  SetCtlColors $0 "D8DAEA" "202231"
  SendMessage $0 ${WM_SETFONT} $FluxFetchSmallFont 1
  ${NSD_CreateCheckBox} 0 174u 100% 18u "I have read and accept the license agreement"
  Pop $FluxFetchLicenseCheckbox
  SendMessage $FluxFetchLicenseCheckbox ${WM_SETFONT} $FluxFetchBodyFont 1
  System::Call '$PLUGINSDIR\FluxFetchButtons.dll::StyleChoice(p $FluxFetchLicenseCheckbox, i 0)'
  ${NSD_SetState} $FluxFetchLicenseCheckbox $FluxFetchLicenseAccepted
  ${NSD_OnClick} $FluxFetchLicenseCheckbox FluxFetchLicenseToggle
  Push $FluxFetchLicenseCheckbox
  Call FluxFetchLicenseToggle
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Continue"
  nsDialogs::Show
FunctionEnd

Function FluxFetchLicenseToggle
  Pop $0
  ${NSD_GetState} $FluxFetchLicenseCheckbox $FluxFetchLicenseAccepted
  GetDlgItem $0 $HWNDPARENT 1
  EnableWindow $0 $FluxFetchLicenseAccepted
FunctionEnd

Function FluxFetchLicenseLeave
  ${if} $FluxFetchLicenseAccepted != ${BST_CHECKED}
    Abort
  ${endif}
FunctionEnd

Function FluxFetchStyleNavigation
  GetDlgItem $0 $HWNDPARENT 1
  System::Call '$PLUGINSDIR\FluxFetchButtons.dll::StyleButton(p r0, i 1)'
  System::Call 'uxtheme::SetWindowTheme(p $0, w "", w "")'
  SetCtlColors $0 "F0F0FA" "7258D8"
  SendMessage $0 ${WM_SETFONT} $FluxFetchBoldFont 1
  GetDlgItem $0 $HWNDPARENT 2
  System::Call '$PLUGINSDIR\FluxFetchButtons.dll::StyleButton(p r0, i 0)'
  System::Call 'uxtheme::SetWindowTheme(p $0, w "", w "")'
  SetCtlColors $0 "F0F0FA" "292B3A"
  SendMessage $0 ${WM_SETFONT} $FluxFetchBodyFont 1
  GetDlgItem $0 $HWNDPARENT 3
  System::Call '$PLUGINSDIR\FluxFetchButtons.dll::StyleButton(p r0, i 0)'
  System::Call 'uxtheme::SetWindowTheme(p $0, w "", w "")'
  SetCtlColors $0 "A4A8C1" "292B3A"
  SendMessage $0 ${WM_SETFONT} $FluxFetchBodyFont 1
FunctionEnd

Function FluxFetchGuiInit
  System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\FluxFetch.ico", i 1, i 32, i 32, i 0x10)p .r0'
  SendMessage $HWNDPARENT ${WM_SETICON} 1 $0
  System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\FluxFetch.ico", i 1, i 16, i 16, i 0x10)p .r0'
  SendMessage $HWNDPARENT ${WM_SETICON} 0 $0
  SetCtlColors $HWNDPARENT "F0F0FA" "171925"
  CreateFont $FluxFetchTitleFont "Segoe UI" 20 700
  CreateFont $FluxFetchBodyFont "Segoe UI" 10
  CreateFont $FluxFetchSmallFont "Segoe UI" 9
  CreateFont $FluxFetchBoldFont "Segoe UI" 10 700
  System::Call 'user32::GetDpiForWindow(p $HWNDPARENT)i .r0'
  StrCpy $FluxFetchDpi $0
  ${if} $FluxFetchDpi == 0
    StrCpy $FluxFetchDpi 96
  ${endif}
  !insertmacro FluxMove $HWNDPARENT 0 0 690 550
  System::Call 'user32::GetSystemMetrics(i 0)i .r0'
  IntOp $0 $0 - $R2
  IntOp $0 $0 / 2
  System::Call 'user32::GetSystemMetrics(i 1)i .r1'
  IntOp $1 $1 - $R3
  IntOp $1 $1 / 2
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r0, i r1, i 0, i 0, i 21)'
  GetDlgItem $0 $HWNDPARENT 1018
  !insertmacro FluxMove $0 28 108 634 330
  GetDlgItem $0 $HWNDPARENT 1037
  !insertmacro FluxMove $0 28 28 460 24
  SendMessage $0 ${WM_SETFONT} $FluxFetchBoldFont 1
  GetDlgItem $0 $HWNDPARENT 1038
  !insertmacro FluxMove $0 28 57 460 24
  SendMessage $0 ${WM_SETFONT} $FluxFetchSmallFont 1
  GetDlgItem $0 $HWNDPARENT 1046
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1035
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1036
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1
  !insertmacro FluxMove $0 512 470 150 34
  SendMessage $0 ${WM_SETFONT} $FluxFetchBodyFont 1
  GetDlgItem $0 $HWNDPARENT 3
  !insertmacro FluxMove $0 396 470 104 34
  SendMessage $0 ${WM_SETFONT} $FluxFetchBodyFont 1
  GetDlgItem $0 $HWNDPARENT 2
  !insertmacro FluxMove $0 28 470 104 34
  SendMessage $0 ${WM_SETFONT} $FluxFetchBodyFont 1
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
  GetDlgItem $0 $HWNDPARENT 1037
  SetCtlColors $0 "A99AFF" "171925"
  GetDlgItem $0 $HWNDPARENT 1038
  SetCtlColors $0 "A4A8C1" "171925"
  GetDlgItem $0 $HWNDPARENT 1028
  SetCtlColors $0 "A4A8C1" "171925"
  Call FluxFetchStyleNavigation
FunctionEnd



Function FluxFetchWelcome
  # UAC starts an elevated inner process. Never replay welcome/scope there.
  ${if} ${UAC_IsInnerInstance}
    StrCpy $FluxFetchInstallScope "all"
    Abort
  ${endif}
  ${if} ${isUpdated}
    Abort
  ${endif}
  !insertmacro MUI_HEADER_TEXT "WELCOME TO FLUXFETCH" "Welcome   /   Options   /   Review   /   Install"
  nsDialogs::Create 1018
  Pop $0
  ${if} $0 == error
    Abort
  ${endif}
  SetCtlColors $0 "" "171925"
  !insertmacro FluxLabel 0 0 100% 32u "Downloads, connected." "F0F0FA"
  SendMessage $0 ${WM_SETFONT} $FluxFetchTitleFont 1
  !insertmacro FluxLabel 0 38u 100% 32u "One place for your files, torrents and OmniLink for Steam.$\r$\nChoose your setup. Review everything before installing." "A4A8C1"
  !insertmacro FluxLabel 0 80u 100% 14u "Who will use FluxFetch?" "A99AFF"
  ${NSD_CreateLabel} 0 104u 2u 37u ""
  Pop $0
  SetCtlColors $0 "A99AFF" "A99AFF"
  
  ${NSD_CreateRadioButton} 12u 108u 93% 16u "Just for me"
  Pop $FluxFetchInstallCurrentUser
  System::Call 'uxtheme::SetWindowTheme(p $FluxFetchInstallCurrentUser, w "", w "")'
  SetCtlColors $FluxFetchInstallCurrentUser "F0F0FA" "171925"
  SendMessage $FluxFetchInstallCurrentUser ${WM_SETFONT} $FluxFetchBoldFont 1
  !insertmacro FluxLabel 27u 126u 90% 14u "Installs for your Windows account. No administrator approval." "A4A8C1"
  SetCtlColors $0 "A4A8C1" "171925"
  SendMessage $0 ${WM_SETFONT} $FluxFetchSmallFont 1
  ${NSD_CreateLabel} 0 156u 2u 37u ""
  Pop $0
  SetCtlColors $0 "53576E" "53576E"
  
  ${NSD_CreateRadioButton} 12u 160u 93% 16u "Everyone on this computer"
  Pop $FluxFetchInstallAllUsers
  System::Call 'uxtheme::SetWindowTheme(p $FluxFetchInstallAllUsers, w "", w "")'
  SetCtlColors $FluxFetchInstallAllUsers "F0F0FA" "171925"
  SendMessage $FluxFetchInstallAllUsers ${WM_SETFONT} $FluxFetchBoldFont 1
  !insertmacro FluxLabel 27u 178u 90% 14u "Available to every account. Windows will ask for approval." "A4A8C1"
  SetCtlColors $0 "A4A8C1" "171925"
  SendMessage $0 ${WM_SETFONT} $FluxFetchSmallFont 1
  StrCpy $FluxFetchAdminHint $0
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Continue"
  ${if} $FluxFetchInstallScope == "all"
    ${NSD_Check} $FluxFetchInstallAllUsers
  ${else}
    ${NSD_Check} $FluxFetchInstallCurrentUser
  ${endif}
  nsDialogs::Show
FunctionEnd

Function FluxFetchWelcomeLeave
  ${NSD_GetState} $FluxFetchInstallAllUsers $0
  ${if} $0 == ${BST_CHECKED}
    StrCpy $FluxFetchInstallScope "all"
    !ifndef FLUXFETCH_SETUP_PREVIEW
    ${ifNot} ${UAC_IsAdmin}
      ShowWindow $HWNDPARENT ${SW_HIDE}
      !insertmacro UAC_RunElevated
      ${if} $0 == 0
      ${andif} $1 == 1
        Quit
      ${endif}
      ShowWindow $HWNDPARENT ${SW_SHOW}
      BringToFront
      SetCtlColors $FluxFetchAdminHint "FFADBA" "171925"
      ${NSD_SetText} $FluxFetchAdminHint "Approval wasn't completed. Try again or choose Just for me."
      # Cancelled/failed consent leaves this welcome page available for retry.
      Abort
    ${endif}
    !endif
  ${else}
    StrCpy $FluxFetchInstallScope "current"
  ${endif}
FunctionEnd

Function FluxFetchConfigure
  ${if} ${isUpdated}
    Abort
  ${endif}
  !insertmacro MUI_HEADER_TEXT "PERSONALIZE YOUR SETUP" "Welcome   /   Options   /   Review   /   Install"
  ${if} ${UAC_IsInnerInstance}
    GetDlgItem $0 $HWNDPARENT 3
    EnableWindow $0 0
  ${endif}
  nsDialogs::Create 1018
  Pop $0
  ${if} $0 == error
    Abort
  ${endif}
  SetCtlColors $0 "" "171925"
  !insertmacro FluxLabel 0 0 100% 28u "Make yourself at home." "F0F0FA"
  SendMessage $0 ${WM_SETFONT} $FluxFetchTitleFont 1
  !insertmacro FluxLabel 0 33u 100% 18u "Choose where to install FluxFetch and set your shortcuts." "A4A8C1"
  !insertmacro FluxLabel 0 58u 100% 15u "Application folder" "A99AFF"
  ${if} $FluxFetchSavedFolder != ""
    StrCpy $INSTDIR $FluxFetchSavedFolder
  ${endif}
  ${NSD_CreateDirRequest} 0 78u 77% 20u "$INSTDIR"
  Pop $FluxFetchFolder
  SetCtlColors $FluxFetchFolder "F0F0FA" "202231"
  SendMessage $FluxFetchFolder ${WM_SETFONT} $FluxFetchSmallFont 1
  ${NSD_CreateBrowseButton} 80% 78u 20% 20u "Browse..."
  Pop $0
  System::Call '$PLUGINSDIR\FluxFetchButtons.dll::StyleButton(p r0, i 0)'
  System::Call 'uxtheme::SetWindowTheme(p $0, w "", w "")'
  SetCtlColors $0 "F0F0FA" "343044"
  SendMessage $0 ${WM_SETFONT} $FluxFetchBodyFont 1
  ${NSD_OnClick} $0 FluxFetchBrowse
  !insertmacro FluxLabel 0 102u 100% 24u "This is where FluxFetch is installed. Choose download folders inside the app." "A4A8C1"
  StrCpy $FluxFetchFolderError $0
  SendMessage $0 ${WM_SETFONT} $FluxFetchSmallFont 1
  !insertmacro FluxLabel 0 122u 100% 15u "Shortcuts and startup" "A99AFF"
  ${NSD_CreateCheckBox} 0 143u 100% 16u "Start menu shortcut"
  Pop $FluxFetchStartMenuCheckbox
  System::Call '$PLUGINSDIR\FluxFetchButtons.dll::StyleChoice(p $FluxFetchStartMenuCheckbox, i 0)'
  System::Call 'uxtheme::SetWindowTheme(p $FluxFetchStartMenuCheckbox, w "", w "")'
  SetCtlColors $FluxFetchStartMenuCheckbox "F0F0FA" "171925"
  ${NSD_SetState} $FluxFetchStartMenuCheckbox $FluxFetchStartMenuState
  ${NSD_CreateCheckBox} 0 163u 100% 16u "Start when I sign in"
  Pop $FluxFetchStartupCheckbox
  System::Call '$PLUGINSDIR\FluxFetchButtons.dll::StyleChoice(p $FluxFetchStartupCheckbox, i 0)'
  System::Call 'uxtheme::SetWindowTheme(p $FluxFetchStartupCheckbox, w "", w "")'
  SetCtlColors $FluxFetchStartupCheckbox "F0F0FA" "171925"
  ${NSD_SetState} $FluxFetchStartupCheckbox $FluxFetchStartupState
  ${NSD_CreateCheckBox} 0 183u 100% 16u "Desktop shortcut"
  Pop $FluxFetchDesktopCheckbox
  System::Call '$PLUGINSDIR\FluxFetchButtons.dll::StyleChoice(p $FluxFetchDesktopCheckbox, i 0)'
  System::Call 'uxtheme::SetWindowTheme(p $FluxFetchDesktopCheckbox, w "", w "")'
  SetCtlColors $FluxFetchDesktopCheckbox "F0F0FA" "171925"
  ${NSD_SetState} $FluxFetchDesktopCheckbox $FluxFetchDesktopState
  SendMessage $FluxFetchStartMenuCheckbox ${WM_SETFONT} $FluxFetchBodyFont 1
  SendMessage $FluxFetchStartupCheckbox ${WM_SETFONT} $FluxFetchBodyFont 1
  SendMessage $FluxFetchDesktopCheckbox ${WM_SETFONT} $FluxFetchBodyFont 1
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Review setup"
  GetFunctionAddress $0 FluxFetchSaveOptions
  nsDialogs::OnBack $0
  nsDialogs::Show
FunctionEnd

Function FluxFetchBrowse
  Pop $0
  ${NSD_GetText} $FluxFetchFolder $0
  nsDialogs::SelectFolderDialog "Choose the FluxFetch installation folder" "$0"
  Pop $0
  ${if} $0 != error
    ${GetFileName} "$0" $1
    ${if} $1 != "FluxFetch"
      StrCpy $0 "$0\FluxFetch"
    ${endif}
    ${NSD_SetText} $FluxFetchFolder "$0"
  ${endif}
FunctionEnd

Function FluxFetchSaveOptions
  ${NSD_GetText} $FluxFetchFolder $0
  StrCpy $FluxFetchSavedFolder $0
  StrCpy $FluxFetchChromeState ${BST_CHECKED}
  StrCpy $FluxFetchEdgeState ${BST_CHECKED}
  StrCpy $FluxFetchFirefoxState ${BST_CHECKED}
  ${NSD_GetState} $FluxFetchStartupCheckbox $FluxFetchStartupState
  ${NSD_GetState} $FluxFetchStartMenuCheckbox $FluxFetchStartMenuState
  ${NSD_GetState} $FluxFetchDesktopCheckbox $FluxFetchDesktopState
FunctionEnd

Function FluxFetchConfigureLeave
  Call FluxFetchSaveOptions
  StrCpy $0 $FluxFetchSavedFolder
  StrLen $1 $0
  ${if} $1 > 220
    StrCpy $2 "Choose a shorter folder path (under 220 characters)."
    Goto path_error
  ${endif}
  StrCpy $1 $0 1 1
  StrCpy $2 $0 1 2
  ${if} $1 != ":"
  ${orif} $2 != "\"
    StrCpy $2 "Use a full local folder path, such as D:\Apps\FluxFetch."
    Goto path_error
  ${endif}
  System::Call 'shlwapi::PathIsRelativeW(w r0)i .r1'
  ${if} $1 != 0
    StrCpy $2 "Choose a full folder path, such as D:\Apps\FluxFetch."
    Goto path_error
  ${endif}
  System::Call 'shlwapi::PathIsRootW(w r0)i .r1'
  ${if} $1 != 0
    StrCpy $2 "Choose a folder inside the drive, such as D:\Apps\FluxFetch."
    Goto path_error
  ${endif}
  ${GetRoot} "$0" $1
  System::Call 'kernel32::GetDriveTypeW(w "$1\")i .r2'
  ${if} $2 != 3
  ${andif} $2 != 2
    StrCpy $2 "Choose a connected local drive for the application."
    Goto path_error
  ${endif}
  # NSIS GetFullPathName can return empty for a folder that does not exist yet.
  # The Win32 form canonicalizes new destinations as well as existing ones.
  System::Call 'kernel32::GetFullPathNameW(w r0, i ${NSIS_MAX_STRLEN}, w .r6, p 0)i .r7'
  ${if} $7 == 0
    StrCpy $2 "This folder path isn't valid. Choose another location."
    Goto path_error
  ${endif}
  StrCpy $INSTDIR $6
  StrCpy $FluxFetchSavedFolder $INSTDIR
  System::Call 'kernel32::GetDiskFreeSpaceExW(w "$1\", *l .r2, p 0, p 0)i .r3'
  ${if} $3 != 0
    System::Int64Op $2 / 1048576
    Pop $2
    IntOp $3 ${APP_64_UNPACKED_SIZE} / 1024
    IntOp $3 $3 + 64
    StrCpy $FluxFetchSpaceText "$3 MB required / $2 MB available"
    ${if} $2 < $3
      StrCpy $2 "There isn't enough free space. Choose another drive or free some space."
      Goto path_error
    ${endif}
  ${endif}
  # Probe the actual target folder so permission/path errors appear before installation.
  StrCpy $4 0
  IfFileExists "$INSTDIR\*" folder_exists 0
    StrCpy $4 1
  folder_exists:
  ClearErrors
  CreateDirectory "$INSTDIR"
  ${if} ${Errors}
    StrCpy $2 "This folder can't be created. Check its name, or choose another location."
    Goto path_error
  ${endif}
  ClearErrors
  GetTempFileName $5 "$INSTDIR"
  ${if} ${Errors}
    StrCpy $2 "Setup can't write to this folder. Choose another location or install for everyone."
    Goto path_error
  ${endif}
  Delete "$5"
  ${if} $4 == 1
    RMDir "$INSTDIR"
  ${endif}
  Return
  path_error:
  SetCtlColors $FluxFetchFolderError "FFADBA" "171925"
  ${NSD_SetText} $FluxFetchFolderError "$2"
  SendMessage $FluxFetchFolder ${EM_SETSEL} 0 -1
  System::Call 'user32::SetFocus(p $FluxFetchFolder)'
  Abort
FunctionEnd

Function FluxFetchReview
  ${if} ${isUpdated}
    Abort
  ${endif}
  !insertmacro MUI_HEADER_TEXT "READY TO INSTALL" "Welcome   /   Options   /   Review   /   Install"
  nsDialogs::Create 1018
  Pop $0
  SetCtlColors $0 "" "171925"
  !insertmacro FluxLabel 0 0 100% 30u "Everything look right?" "F0F0FA"
  SendMessage $0 ${WM_SETFONT} $FluxFetchTitleFont 1
  !insertmacro FluxLabel 0 36u 100% 20u "Review your choices. Go Back to change anything." "A4A8C1"
  !insertmacro FluxCard 65u 112u
  StrCpy $1 "Your Windows account"
  ${if} $installMode == "all"
    StrCpy $1 "Everyone on this computer"
  ${endif}
  !insertmacro FluxLabel 12u 75u 94% 18u "$1" "A99AFF"
  SetCtlColors $0 "A99AFF" "202231"
  !insertmacro FluxLabel 12u 99u 94% 30u "$INSTDIR" "F0F0FA"
  SetCtlColors $0 "F0F0FA" "202231"
  StrCpy $1 ""
  ${if} $FluxFetchChromeState == ${BST_CHECKED}
    StrCpy $1 "$1 Chrome"
  ${endif}
  ${if} $FluxFetchEdgeState == ${BST_CHECKED}
    StrCpy $1 "$1 Edge"
  ${endif}
  ${if} $FluxFetchFirefoxState == ${BST_CHECKED}
    StrCpy $1 "$1 Firefox"
  ${endif}
  ${if} $1 == ""
    StrCpy $1 " None"
  ${endif}
  StrCpy $1 "Update / Keep settings and history"
  ${if} $FluxFetchFreshState == ${BST_CHECKED}
    StrCpy $1 "Fresh install / Reset settings and history"
  ${endif}
  !insertmacro FluxLabel 12u 130u 94% 18u "$1" "A4A8C1"
  SetCtlColors $0 "A4A8C1" "202231"
  StrCpy $1 "Shortcuts:"
  ${if} $FluxFetchStartMenuState == ${BST_CHECKED}
    StrCpy $1 "$1 Start menu"
  ${endif}
  ${if} $FluxFetchDesktopState == ${BST_CHECKED}
    StrCpy $1 "$1 Desktop"
  ${endif}
  ${if} $1 == "Shortcuts:"
    StrCpy $1 "Shortcuts: None"
  ${endif}
  ${if} $FluxFetchStartupState == ${BST_CHECKED}
    StrCpy $1 "$1 / Start at sign-in"
  ${endif}
  !insertmacro FluxLabel 12u 152u 94% 20u "$1" "A4A8C1"
  SetCtlColors $0 "A4A8C1" "202231"
  !insertmacro FluxLabel 0 184u 100% 16u "$FluxFetchSpaceText" "A4A8C1"
  SendMessage $0 ${WM_SETFONT} $FluxFetchSmallFont 1
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Install FluxFetch"
  nsDialogs::Show
FunctionEnd

Function FluxFetchProgressShow
  !insertmacro MUI_HEADER_TEXT "INSTALLING FLUXFETCH" "Your files are being prepared. Setup will finish automatically."
  FindWindow $0 "#32770" "" $HWNDPARENT
  !insertmacro FluxMove $0 28 108 634 330
  SetCtlColors $0 "F0F0FA" "171925"
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "Getting everything ready.", i 0x50000000, i 0, i 0, i 1, i 1, p r0, p 0, p 0, p 0)p .r1'
  !insertmacro FluxMove $1 0 16 630 48
  SetCtlColors $1 "F0F0FA" "171925"
  SendMessage $1 ${WM_SETFONT} $FluxFetchTitleFont 1
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "Installing FluxFetch and your selected connections.", i 0x50000000, i 0, i 0, i 1, i 1, p r0, p 0, p 0, p 0)p .r1'
  !insertmacro FluxMove $1 0 80 630 32
  SetCtlColors $1 "A4A8C1" "171925"
  SendMessage $1 ${WM_SETFONT} $FluxFetchBodyFont 1
  GetDlgItem $1 $0 1006
  !insertmacro FluxMove $1 0 128 630 42
  SetCtlColors $1 "A4A8C1" "171925"
  SendMessage $1 ${WM_SETFONT} $FluxFetchBodyFont 1
  GetDlgItem $1 $0 1004
  !insertmacro FluxMove $1 0 188 630 14
  System::Call 'uxtheme::SetWindowTheme(p r1, w "", w "")'
  SendMessage $1 0x2001 0 0x312220
  SendMessage $1 0x409 0 0xFF9AA9
FunctionEnd

Function FluxFetchReady
  GetDlgItem $0 $HWNDPARENT 1046
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
  System::Call 'user32::GetSystemMenu(p $HWNDPARENT, i 0)p .r0'
  System::Call 'user32::EnableMenuItem(p r0, i 0xF060, i 0)'
  System::Call 'user32::DrawMenuBar(p $HWNDPARENT)'
  !insertmacro MUI_HEADER_TEXT "INSTALLATION COMPLETE" "FluxFetch is ready for your next download."
  nsDialogs::Create 1018
  Pop $0
  SetCtlColors $0 "" "171925"
  !insertmacro FluxLabel 0 3u 100% 32u "You're ready to go." "56D8BD"
  SendMessage $0 ${WM_SETFONT} $FluxFetchTitleFont 1
  !insertmacro FluxLabel 0 43u 100% 30u "Your setup is complete. Add a link, open a torrent,$\r$\nor explore OmniLink from the download library." "A4A8C1"
  !insertmacro FluxCard 84u 76u
  ${if} $FluxFetchChromeState != ${BST_CHECKED}
  ${andif} $FluxFetchEdgeState != ${BST_CHECKED}
  ${andif} $FluxFetchFirefoxState != ${BST_CHECKED}
    StrCpy $1 "Your download library is ready"
    StrCpy $2 "Add links directly in FluxFetch to get started.$\r$\nYou can set up browser connections later."
  ${else}
    StrCpy $1 "One more step for browser downloads"
    StrCpy $2 "Finish adding the companion extension in your browser.$\r$\nFluxFetch will open the setup page when you click Finish."
  ${endif}
  !insertmacro FluxLabel 12u 94u 94% 17u "$1" "F0F0FA"
  SetCtlColors $0 "F0F0FA" "202231"
  !insertmacro FluxLabel 12u 119u 94% 33u "$2" "A4A8C1"
  SetCtlColors $0 "A4A8C1" "202231"
  SendMessage $0 ${WM_SETFONT} $FluxFetchSmallFont 1
  ${NSD_CreateCheckBox} 0 180u 100% 18u "Open FluxFetch now"
  Pop $FluxFetchRun
  System::Call '$PLUGINSDIR\FluxFetchButtons.dll::StyleChoice(p $FluxFetchRun, i 0)'
  System::Call 'uxtheme::SetWindowTheme(p $FluxFetchRun, w "", w "")'
  SetCtlColors $FluxFetchRun "F0F0FA" "171925"
  SendMessage $FluxFetchRun ${WM_SETFONT} $FluxFetchBodyFont 1
  ${NSD_Check} $FluxFetchRun
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Finish"
  nsDialogs::Show
FunctionEnd

Function FluxFetchReadyLeave
  !ifdef FLUXFETCH_SETUP_PREVIEW
    Return
  !endif
  ${NSD_GetState} $FluxFetchRun $0
  ${if} $0 == ${BST_CHECKED}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
  ${endif}
  ${if} $FluxFetchChromeState == ${BST_CHECKED}
    ${StdUtils.ExecShellAsUser} $0 "chrome://extensions" "open" ""
  ${endif}
  ${if} $FluxFetchEdgeState == ${BST_CHECKED}
    ${StdUtils.ExecShellAsUser} $0 "edge://extensions" "open" ""
  ${endif}
  ${if} $FluxFetchFirefoxState == ${BST_CHECKED}
    ${StdUtils.ExecShellAsUser} $0 "about:addons" "open" ""
  ${endif}
FunctionEnd
!macroend



!macro customInstall
!ifndef BUILD_UNINSTALLER
  # Register as a candidate without modifying Windows' protected UserChoice default.
  WriteRegStr SHELL_CONTEXT "Software\Classes\FluxFetch.Torrent" "" "FluxFetch torrent file"
  WriteRegStr SHELL_CONTEXT "Software\Classes\FluxFetch.Torrent\DefaultIcon" "" '$\"$appExe$\",0'
  WriteRegStr SHELL_CONTEXT "Software\Classes\FluxFetch.Torrent\shell\open\command" "" '$\"$appExe$\" $\"%1$\"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\.torrent\OpenWithProgids" "FluxFetch.Torrent" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\fluxfetch.exe" "FriendlyAppName" "FluxFetch"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\fluxfetch.exe\SupportedTypes" ".torrent" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\fluxfetch.exe\shell\open\command" "" '$\"$appExe$\" $\"%1$\"'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${if} $FluxFetchFreshState == ${BST_CHECKED}
    SetShellVarContext current
    CreateDirectory "$APPDATA\FluxFetch"
    Delete "$APPDATA\FluxFetch\app-settings.json"
    Delete "$APPDATA\FluxFetch\network-preferences.json"
    Delete "$APPDATA\FluxFetch\site-auth.bin"
    Delete "$APPDATA\FluxFetch\browser-queue.bin"
    Delete "$APPDATA\FluxFetch\scheduled-downloads.bin"
    RMDir /r "$APPDATA\FluxFetch\Local Storage"
    RMDir /r "$APPDATA\FluxFetch\Session Storage"
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endif}
  WriteRegDWORD SHELL_CONTEXT "Software\FluxFetch\Installer" "ChromeIntegration" $FluxFetchChromeState
  WriteRegDWORD SHELL_CONTEXT "Software\FluxFetch\Installer" "EdgeIntegration" $FluxFetchEdgeState
  WriteRegDWORD SHELL_CONTEXT "Software\FluxFetch\Installer" "FirefoxIntegration" $FluxFetchFirefoxState
  WriteRegDWORD SHELL_CONTEXT "Software\FluxFetch\Installer" "StartMenuShortcut" $FluxFetchStartMenuState
  WriteRegDWORD SHELL_CONTEXT "Software\FluxFetch\Installer" "DesktopShortcut" $FluxFetchDesktopState
  ${if} $FluxFetchDesktopState != ${BST_CHECKED}
    WinShell::UninstShortcut "$newDesktopLink"
    Delete "$newDesktopLink"
  ${endif}
  ${if} $FluxFetchChromeState == ${BST_CHECKED}
    WriteRegStr SHELL_CONTEXT "Software\Google\Chrome\NativeMessagingHosts\com.fluxfetch.browser" "" "$INSTDIR\resources\browser\com.fluxfetch.browser.json"
  ${else}
    DeleteRegKey SHELL_CONTEXT "Software\Google\Chrome\NativeMessagingHosts\com.fluxfetch.browser"
  ${endif}
  ${if} $FluxFetchEdgeState == ${BST_CHECKED}
    WriteRegStr SHELL_CONTEXT "Software\Microsoft\Edge\NativeMessagingHosts\com.fluxfetch.browser" "" "$INSTDIR\resources\browser\com.fluxfetch.browser.json"
  ${else}
    DeleteRegKey SHELL_CONTEXT "Software\Microsoft\Edge\NativeMessagingHosts\com.fluxfetch.browser"
  ${endif}
  ${if} $FluxFetchFirefoxState == ${BST_CHECKED}
    WriteRegStr SHELL_CONTEXT "Software\Mozilla\NativeMessagingHosts\com.fluxfetch.browser" "" "$INSTDIR\resources\browser\com.fluxfetch.browser.firefox.json"
  ${else}
    DeleteRegKey SHELL_CONTEXT "Software\Mozilla\NativeMessagingHosts\com.fluxfetch.browser"
  ${endif}
  ${if} $FluxFetchStartupState == ${BST_CHECKED}
    StrCpy $0 '"$appExe"'
    WriteRegStr SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\Run" "FluxFetch" $0
  ${else}
    DeleteRegValue SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\Run" "FluxFetch"
  ${endif}
  ${if} $FluxFetchStartMenuState == ${BST_CHECKED}
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${else}
    Delete "$newStartMenuLink"
  ${endif}
!endif
!macroend

!macro customCheckAppRunning
  System::Call 'kernel32::GetCurrentProcessId()i .r0'
  StrCpy $pid $0
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 == 0
    DetailPrint "Closing FluxFetch before installation..."
    !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 0
    Sleep 1000
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 == 0
      !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 1
      Sleep 1000
    ${endif}
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 == 0
      Abort "FluxFetch could not be closed. Installation stopped before changing its files."
    ${endif}
  ${endif}
!macroend

!macro customUnInstall
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.torrent\OpenWithProgids" "FluxFetch.Torrent"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\FluxFetch.Torrent"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\fluxfetch.exe"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  DeleteRegKey SHELL_CONTEXT "Software\Google\Chrome\NativeMessagingHosts\com.fluxfetch.browser"
  DeleteRegKey SHELL_CONTEXT "Software\Microsoft\Edge\NativeMessagingHosts\com.fluxfetch.browser"
  DeleteRegKey SHELL_CONTEXT "Software\Mozilla\NativeMessagingHosts\com.fluxfetch.browser"
  DeleteRegValue SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\Run" "FluxFetch"
  DeleteRegKey SHELL_CONTEXT "Software\FluxFetch\Installer"
  WinShell::UninstShortcut "$oldStartMenuLink"
  Delete "$oldStartMenuLink"
!macroend








