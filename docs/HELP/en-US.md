# bonis oculis help

bonis oculis checks a movie once, here on this computer, and writes down where the scenes you do not want are. When anyone presses Play, those scenes are skipped. Nothing is sent anywhere.

## What you need {#requirements}

- **Windows:** Windows 10 (version 1809 or later) or Windows 11, 64-bit.
- **Mac with Apple Silicon** (M1 or later): macOS 14 Sonoma or later. Use the download whose name ends in **arm64**.
- **Mac with Intel:** macOS 12 Monterey or later. Use the download whose name ends in **x64**. To see which Mac you have, open the Apple menu › **About This Mac**: it says **Chip** (Apple Silicon) or **Processor** (Intel).
- At least **4 GB of memory** and **3 GB of free disk space**, plus room for any clean copies you make.
- A computer with a video chip scans and makes clean copies faster. Without one it still works, only more slowly.
- On computers from before about 2013, the checks that listen to the dialogue are skipped; the picture and the subtitles are still checked.

## Before you install {#install}

This early version of bonis oculis is not signed by Apple or Microsoft yet, so your computer asks before it opens it the first time. You do this only once. bonis oculis never connects to the internet, so it is fine if your firewall blocks it.

**On a Mac with macOS 15 (Sequoia) or later**

1. Open the downloaded .dmg file and drag **bonis oculis** into the **Applications** folder.
2. Open **Applications** and double-click **bonis oculis**. A message says it was not opened. Choose **Done**. (Control-click and **Open** no longer works on these versions.)
3. Open the Apple menu › **System Settings** › **Privacy & Security**.
4. Scroll down to **Security**. Next to "bonis oculis was blocked", choose **Open Anyway**.
5. Type your Mac password, then choose **Open Anyway** once more.

From then on it opens normally.

**On a Mac with macOS 14 or earlier**

1. Drag **bonis oculis** into the **Applications** folder.
2. Hold the Control key and click the app, then choose **Open**.
3. In the message that appears, choose **Open** again.

**On Windows 10 or 11**

1. If your browser says the file is not commonly downloaded, choose **Keep** (in Edge: the three dots › **Keep** › **Show more** › **Keep anyway**).
2. Double-click the installer.
3. If a blue window says "Windows protected your PC" (Microsoft Defender SmartScreen), click **More info**.
4. Click **Run anyway**.

## Getting started {#start}

The first time bonis oculis opens, it asks for your language, a parent PIN, how much to skip, and a first movie.

- **The PIN** keeps the library, reviews and settings for grown-ups. Pick one that is not easy to guess (not 1234 or 0000).
- **The recovery code** is shown once. Write it down and keep it away from the kids. It is the only way back in if you forget the PIN.
- **The levels** say how sure we must be before a scene is skipped. You can change them any time in Settings › Protection.

## How scanning works {#scanning}

When you add a movie, bonis oculis looks at it once and makes a list of the scenes to skip. It reads the subtitles, listens to the dialogue, and looks at the picture and the sound. The movie itself is never changed.

- **How long it takes.** On an ordinary laptop a two-hour movie takes about 30 to 60 minutes when it has subtitles, and longer without them. **Thorough scan** in Settings › Scanning is slower and looks at more scenes.
- **It works in the background.** You can keep using the app. Scanning runs at low priority so the computer stays usable.
- **It pauses by itself** while a movie plays, and on a laptop running on battery (you can change both in Settings › Scanning).
- **Nothing is lost.** If the computer sleeps or the app closes, the scan continues where it stopped next time.
- **One movie at a time.** The others wait in the scan queue at the bottom of the library.

When the scan is done, the movie shows **Needs review**. A movie never goes to the kids' screen until a parent has looked at it, even when the scan found nothing.

## Reviewing without watching {#review}

Open a movie with **Review**. You will see:

- **What parents need to know**: for each kind of scene, what we found and what will happen to it. **Not checked** means that kind is turned off in your levels (or its check was skipped), so we did not look. **None found** means we looked and found nothing. We never describe a scene.
- **The timeline**: each coloured block is a scene. Colour, pattern and an icon tell the kind of scene. Hover over the legend to read what each kind means.
- **The scene panel** on the right, when you pick a scene: a blurred picture, a short note, how sure we are, and what happens when it plays.

For each scene you can:

1. **Skip this scene**: it will be skipped (or covered, or muted, as shown under "When it plays").
2. **Let it play**: it plays normally. Use this when we were wrong.
3. **Move the edges** a little earlier or later with the buttons, or with the arrow keys on the handles (0.5 seconds; with Shift, 5 seconds).
4. **Change the category** or **what happens** when it plays.
5. **Hold to peek**: after you type the PIN, and only while you hold the button, you see the real frame from the movie, only a little blurred. It asks for the PIN again after 5 minutes. Nothing is saved.

Some scenes say **Below your level — will play unless you skip it**. We found them, but we are not sure enough for the level you chose, so they play. Press **Skip this scene** if you want them gone.

**For this movie.** The levels in Settings apply to every movie. To be stricter or gentler with one movie only, press **For this movie** in its review (or in the summary before Play). **Use my usual levels** undoes it. The player, the Kodi list and the clean copy follow the movie's own levels. Scenes you already decided stay as you decided.

**Keys.** When you pick a scene, the keyboard goes to the panel. **S** skips the scene, **L** lets it play, **N** goes to the next scene and **P** to the previous one. In the timeline, **Home** and **End** jump to the nearest scene cut.

Every change is saved the moment you make it. A message at the bottom left offers **Undo** for a few seconds.

**Skip all N scenes** skips every scene still waiting, even the ones below your level. **Mark as fully reviewed** is for a movie you checked on your own.

**An imported skip file** (from another family, or made for another copy) arrives with every scene waiting. The movie shows **Needs review — imported list** until you look it over and press **Use this list for kids**.

**When nothing was found**, the movie still waits for you. If you know the movie, press **Looks clean — approve for kids**. Only then can kids play it.

> We can miss things, and we sometimes flag a scene that is fine. That is why the review exists. You can also mark a scene while you watch (see [The panic key](#panic)).

## Playing for kids {#kids}

When the app is locked, kids see only the movies you approved, as big tiles. They press one and the movie opens in its own window.

- A movie appears for kids only when it has been scanned and a parent has decided every scene (or approved a movie where nothing was found).
- If anything is wrong with its list of scenes, the movie does not play for kids. It never plays unprotected in kid mode.
- To get back to the library, press **Parent** and enter the PIN.
- Lock the app with **Lock for kids** in the side bar. It also locks by itself after 10 minutes without use. Change this in Settings › PIN (5, 10 or 30 minutes, or never). A message warns you 30 seconds before. While a movie plays in parent mode the app does not lock, and what you do on the Now playing page does not count as being there. If the time ran out during the movie, the app locks as soon as the movie reaches its end, you press **Stop**, or you close the movie's window. When the app opens in kid mode (the usual setup), it also locks when you switch to another app: see **Lock when I switch to another app** in Settings › PIN.

**Before you play in parent mode** a short summary says what will happen, for example "12 scenes will be skipped · 1 muted · 2 will play (below your level)". Press **Play**, or **Review first** to look again. In kid mode the movie plays straight away.

**If a scene list is damaged** (for example after a disk problem) and the backup cannot be used, the movie shows **Needs attention — scene list damaged** and is never shown as protected. Kids cannot play it. In parent mode, Play asks before it plays the movie without protection. Scan it again to fix it.

## The panic key {#panic}

If something appears that should not, press **P** (or **Ctrl+Space**). The screen goes black and silent at once.

- Press **P** again, or **Enter**, to come back. The scene is saved and skipped from then on, starting two seconds before you pressed the key.
- While the screen is hidden, the right arrow jumps ahead 10 seconds.
- You can choose another letter in Settings › Playback.
- When a kid uses it, the movie's card in the library says **A moment was hidden during playback — take a look** until you open its review. The hidden part stays skipped either way.

**Marking while you watch (parents).** Press **I** where a scene starts and **O** where it ends. **U** undoes the last mark. Marks are saved at once and wait for your review. These keys are off in kid mode.

## Watching on your TV {#tv}

bonis oculis cannot change what streaming apps show on the TV. It works with movie files you own. These steps are for a Fire TV, such as a Hisense Fire TV or a Fire TV Stick. The menus can differ a little between models.

The TV files follow your levels exactly as the app's player does: a scene below your level is not cut or listed, a scene you skip is.

### Easiest: a clean copy on a USB stick with VLC

**On the computer**

1. In bonis oculis, open **Send to TV**, choose the movie, and press **Make a clean copy**. You get a new video file with the skipped scenes cut out. Your original stays as it is. The app first tries a few seconds of the movie and tells you about how long the copy will take. This makes a new file; it takes a while on computers without a video chip (often close to an hour for a two-hour film on an older laptop). You can keep using the computer, and **Cancel** leaves nothing behind.
2. Copy the new file to a USB stick formatted as **exFAT** (best) or **FAT32**. FAT32 cannot hold a file bigger than 4 GB. A new stick is usually ready as it comes. If you need to format it, do it on the computer, before you copy the movie.

**On the TV, once**

3. Press the Home button, open the **Appstore** (Amazon Appstore), search for **VLC** and install it. It is free.

**Every time**

4. Plug the stick into the TV. If the TV offers to **format** the stick or use it as **internal storage**, say no: choose **View**, **Cancel** or **Not now**. Formatting erases the movie.
5. Open VLC, go to **Browsing**, choose the stick by its name, and pick the movie.

**What the copy has.** Not one frame of a cut scene is left, and the sound stays in step with the picture after every cut. The picture is made again as an H.264 video in an .mp4 file, which TVs and VLC play. Every sound track is kept (each language), always as AAC, so you do not need **Also convert the sound to AAC** any more. Up to 5.1 surround is kept. Subtitles are not included in the clean copy, because they could still show the words of a cut scene. A movie in HDR is converted to normal colors, so it may look a little flatter. Making the copy takes a while on a computer without a video chip; before it starts, bonis oculis measures how long it will take on this computer and shows the time left while it works.

### Advanced: Kodi with a Kodi list (.edl)

Kodi is a free player that skips scenes by itself, using a small .edl file next to the movie. You keep the original movie. Kodi is not in the Amazon Appstore, so it takes a few more steps the first time.

**On the TV, once: turn on Developer options**

1. Press the Home button and open **Settings** (the gear).
2. Open **Device & Software** (on a Fire TV Stick: **My Fire TV**), then **About**.
3. Select the name of your TV or stick (the first line) **7 times** in a row. A message says you are now a developer.
4. Go back one step. **Developer options** is now in the list.

**On the TV, once: install Downloader, then Kodi**

5. Open the **Appstore**, search for **Downloader** (the orange app by AFTVnews) and install it. Install it first: the next step only lists apps that are already installed.
6. Go to **Settings** › **Device & Software** (or **My Fire TV**) › **Developer options** › **Install unknown apps**, and turn **Downloader** on. If Downloader is not in the list, update the TV under **Settings** › **Device & Software** › **About** › **Check for updates**, then try again.
7. Open Downloader, type `kodi.tv/download` in its address box and choose **Go**.
8. Choose **Android**, then **ARMV7A (32BIT)**. Most Fire TVs cannot install the 64-bit version.
9. When the download ends, choose **Install**. Then choose **Delete** to remove the installer file. Kodi is now with your apps.

**On the computer**

10. In bonis oculis, open **Send to TV** and press **Save Kodi list**. A file with the same name as the movie and the ending .edl is saved.
11. Copy the movie and its .edl file together to the same folder on the USB stick. Keep both names exactly the same, apart from the ending.

**Every time**

12. Plug the stick into the TV. If the TV offers to format it, say no, as above.
13. Open Kodi. The first time, it asks to use the TV's storage: choose **Allow**.
14. Go to **Videos** › **Files** › **Add videos…** › **Browse**, choose the USB stick by its name, then **OK**, and **OK** again. (Kodi on a Fire TV does not list the stick until you add it this way. You do this once per stick.)
15. Open the stick under **Videos** › **Files** and play the movie. The listed scenes are skipped.

> A Kodi list follows the copy of the movie it was made for. If you use a different copy of the movie, scan that copy instead.

## What bonis oculis cannot do {#limits}

- It cannot filter streaming apps on the TV (Netflix, Prime Video, Disney+ and others) or live TV. It works with movie files on your computer.
- It cannot scan movies protected against copying (DRM), such as rentals and purchases inside streaming apps.
- It is automatic, so it can miss a scene or flag one that is fine. Gore is the hardest kind to find. Review what we found, and use the panic key if something slips through.
- **People versus a machine.** Services such as ClearPlay or Common Sense Media have people watch every movie. bonis oculis uses an automatic scan plus your own review, so it can be wrong in ways a person watching would not be.
- **No age rating.** It does not say a movie is right for an age. Only you know your child, so it only skips the scenes you chose.

## The PIN and its limits {#pin}

The PIN keeps settings, reviews and the library for grown-ups.

- After 5 wrong tries the PIN pad waits 30 seconds, and longer after each new wrong try.
- If you forget the PIN, press **Parent** on the kid screen, then **I forgot my PIN**, and type the recovery code you wrote down at setup. You then get a new code.
- **Activity** (Settings › PIN) lists, for parents only, when the app was unlocked, wrong PINs, changes to settings and levels, movies played without protection, uses of the panic key and your approvals. It is kept on this computer only.
- If the file that keeps the PIN disappears, the app does not offer a new PIN. It stays locked and asks for the recovery code. A second copy of the code's check is kept in another file for this.
- The PIN is a family lock, not a safe. Someone with an administrator account on this computer can get around it. Deleting both PIN files resets the app, for example. Settings and scene lists are signed, so changes made outside the app are noticed: the movie shows **Needs review — the list changed outside the app** and kids cannot play it until you look at it and press **Use this list for kids**. Keep the administrator account for grown-ups.

## Privacy {#privacy}

- bonis oculis has no account, no ads and no statistics, and it never connects to the internet.
- Pictures of flagged scenes are blurred before they are saved. A clear picture is never written to disk. **Hold to peek** shows the real frame only while you hold it, and does not save it.
- Your library, reviews, activity and settings stay in the app's folder on this computer. Files are only shared when you press an export button.
- The first time each version opens, bonis oculis checks in the background that its bundled programs and detection files are exactly the ones it shipped with. If one is not, the library says **Needs attention: a bundled file is damaged** and names it. Install the app again.

## How accurate is it? {#accuracy}

bonis oculis is automatic, so it makes two kinds of mistakes:

- **Misses**: a scene you did not want that we did not catch. These matter most, so the app is set to catch too much rather than too little.
- **False alarms**: something we flagged that was fine. You fix these in a few seconds with **Let it play** during the review.

Because a movie is checked before anyone watches it, you can look over what we found. Still, no automatic tool catches everything, so keep the panic key in mind.

**Check accuracy** (the movie's **More** menu, or Settings › About) compares the **automatic scan**, as it was before your review, with a list of scenes made by hand by someone who watched the whole movie. That list must be its own skip file: another family's export, or one made for that purpose. The movie's own list does not count, because your review and your marks are already in it; the app refuses it. You see, for each kind of scene, how much we caught, how much of what we flagged was right, the time we missed and the false alarms, each with a one-line explanation. One movie is only one example: check a few to get a fair picture.
