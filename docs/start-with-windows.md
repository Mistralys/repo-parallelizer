# Start with Windows

This guide shows how to launch the Paralizer GUI server (`paralizer serve`) automatically every time you log into Windows, without leaving a command prompt window open.

## Prerequisites

Run `npm link` once in the project folder so that the `paralizer` command is available globally. The startup script calls `paralizer` by name and will not work without it.

## Setup

1. Press `Win + R`, type the following command to open your user Startup folder, and press **Enter**:
   ```
   shell:startup
   ```
   *(This opens the folder: `C:\Users\<YourUsername>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup`)*

2. In that folder, right-click an empty area and select **New** > **Text Document**.
3. Name it `start-repo-parallelizer.vbs` (make sure you remove the `.txt` extension!).
4. Right-click the new file, select **Edit** (or open it with Notepad/VS Code), and paste the following code into it:

   ```vbscript
   Set WshShell = CreateObject("WScript.Shell")
   ' 0 means the window will be hidden, so you don't have a lingering terminal
   WshShell.Run "cmd /c paralizer serve", 0
   Set WshShell = Nothing
   ```

5. Save and close the file.

## How it works

Every time you log into Windows, this script launches the server in the background without leaving an unused command prompt window on your taskbar. The background Node.js process runs exactly as it normally does.

## Undo

To stop the server from starting automatically, delete `start-repo-parallelizer.vbs` from the Startup folder (open it again with `Win + R` and `shell:startup`). A server that is already running keeps running until you end its Node.js process or log out.
