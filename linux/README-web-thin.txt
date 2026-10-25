Crazy Taxi web-thin for Linux (x64 and arm64, Raspberry Pi included)

Plays the hosted game at https://ct.gokart.games/ in a Chrome or Chromium app window: no tabs or
address bar, 1280x960, its own profile. No game files are bundled, so it needs an internet connection
and always runs the latest deployed version.

1. Unpack:
     tar -xzf CrazyTaxi-web-thin-*-linux.tar.gz
2. Install (one step):
     ./CrazyTaxi-web-thin/install.sh
   If no Chrome, Chromium, Edge or Brave is installed, it installs Google Chrome on x64 (apt / dnf) or
   Chromium on arm64 and other distros. Then it adds "Crazy Taxi Web" to the Games menu, adds a
   `crazytaxi-web` command and starts the game.

Other ways:
  ./CrazyTaxi-web-thin/CrazyTaxi     play without installing
  ./install.sh --uninstall            removes the app, menu entry and saved settings

Pick a browser:  CT_BROWSER=chromium ./CrazyTaxi
Other URL (e.g. a local server):  CT_WEB_URL=http://192.168.1.10:5173/ ./CrazyTaxi
F11 toggles full screen.
