# bonis oculis help

bonis oculis checks a movie once, here on this computer, and writes down where the scenes you do not want are. When anyone presses Play, those scenes are skipped. Nothing is sent anywhere.

## Opening the app for the first time {#start}

This early version of bonis oculis is not signed by Apple or Microsoft yet, so your computer asks before it opens it the first time. This happens only once.

**On a Mac**

1. Open the Applications folder and find bonis oculis.
2. Hold the Control key and click the app (or right-click it), then choose **Open**.
3. In the message that appears, choose **Open** again.

From then on it opens normally.

**On Windows**

1. Double-click the installer or the app.
2. If a blue window says "Windows protected your PC", click **More info**.
3. Click **Run anyway**.

> bonis oculis never connects to the internet, so it is fine if your firewall blocks it.

## How scanning works {#scanning}

When you add a movie, bonis oculis looks at it once and makes a list of the scenes to skip. It reads the subtitles and looks at the picture, a frame or two every second. The movie itself is never changed.

- **How long it takes.** On an ordinary laptop a two-hour movie takes about 30 to 60 minutes when it has subtitles, and longer without them. A newer computer is faster.
- **It works in the background.** You can keep using the app. Scanning runs at low priority so the computer stays usable.
- **It pauses by itself** while a movie plays, and on a laptop running on battery (you can change both in Settings > Scanning).
- **Nothing is lost.** If the computer sleeps or the app closes, the scan continues where it stopped next time.
- **One movie at a time.** The others wait in the scan queue at the bottom of the library.

When the scan is done, the movie shows **To review** or **Protected**.

## Reviewing without watching {#review}

Open a movie with **Review**. You will see:

- **What parents need to know**: how many scenes of each kind we found and how strong they are. We never describe a scene.
- **The timeline**: each coloured block is a scene. Colour, pattern and an icon tell the kind of scene.
- **The scene panel** on the right, when you pick a scene: a blurred picture, a short note, how sure we are, and what happens when it plays.

For each scene you can:

1. **Approve** it: it will be skipped (or hidden, or muted, as shown under "When it plays").
2. **Reject** it: it plays normally. Use this when we were wrong.
3. **Move the edges** a little earlier or later with the buttons, or with the arrow keys on the handles (0.5 seconds; with Shift, 5 seconds).
4. **Change the category** or **what happens** when it plays.
5. **Hold to peek**: a parent can see a little more of the picture while the button is held. It asks for the PIN, and again after 5 minutes. The picture is still soft and it is never saved.

Every change is saved the moment you make it. A message offers **Undo** if you change your mind.

**Approve all** accepts every scene still waiting. **Mark as fully reviewed** is for a movie you checked yourself.

> We can miss things, and we sometimes flag a scene that is fine. That is why the review exists. You can also mark a scene while you watch (see below).

## Playing for kids {#kids}

When the app is locked, kids see only the movies you approved, as big tiles. They press one and the movie opens in its own window.

- A movie appears for kids only when it has been scanned and every scene has been decided.
- If anything is wrong with its list of scenes, the movie does not play for kids. It never plays unprotected.
- To get back to the library, press **Parent** and enter the PIN.
- Lock the app again with **Lock for kids** at the bottom of the side bar.

## The panic key {#panic}

If something appears that should not, press **P** (or **Ctrl+Space**). The screen goes black and silent at once.

- Press **P** again, or **Enter**, to come back. The scene is saved and skipped from then on, starting two seconds before you pressed the key.
- While the screen is hidden, the right arrow jumps ahead 10 seconds.
- You can choose another letter in Settings > Playback.

**Marking while you watch (parents).** Press **I** where a scene starts and **O** where it ends. **U** undoes the last mark. Marks are saved at once and wait for your review. These keys are off in kid mode.

## Watching on your TV {#tv}

bonis oculis cannot change what streaming apps show on the TV. It works with movie files you own. There are two ways to take a protected movie to a Fire TV (such as a Hisense Fire TV).

### Easiest: a clean copy on a USB stick with VLC

1. In bonis oculis, open **Send to TV**, choose the movie, and press **Make a clean copy**. You get a new video file with the scenes cut out. Your original stays as it is.
2. Copy the new file to a USB stick. Use a stick formatted as **exFAT** for big movies (FAT32 cannot hold files over 4 GB).
3. On the TV, open the **Amazon Appstore**, search for **VLC** and install it. It is free.
4. Plug the stick into the TV, open VLC, go to **Browse** and pick the movie.

If the copy plays without sound on your TV, make it again with **Also convert the sound to AAC** turned on.

### Advanced: Kodi with a Kodi list (.edl)

Kodi is a free player that can skip scenes by itself using a small .edl file next to the movie.

1. Kodi is not in the Amazon Appstore. On the Fire TV go to **Settings > My Fire TV > Developer options** and allow apps from unknown sources, then install the **Downloader** app from the Appstore and use it to install Kodi from kodi.tv.
2. In bonis oculis, open **Send to TV** and press **Save Kodi list**. A file with the same name as the movie and the ending .edl is saved next to it.
3. Put the movie and its .edl file together in the same folder on a USB stick or on a shared folder Kodi can reach.
4. Play the movie in Kodi. The listed scenes are skipped.

> A Kodi list follows the movie it was made for. If you use a different copy of the movie, scan that copy instead.

## What bonis oculis cannot do {#limits}

- It cannot filter streaming apps on the TV (Netflix, Prime Video, Disney+ and others) or live TV. It works with movie files on your computer.
- It cannot scan movies protected against copying (DRM), such as rentals and purchases inside streaming apps.
- It is automatic, so it can miss a scene or flag one that is fine. Gore is the hardest kind to find. Review what we found, and use the panic key if something slips through.
- It does not judge whether a movie is right for your child. It only skips the scenes you chose.

## The PIN and its limits {#pin}

The PIN keeps settings, reviews and the library for grown-ups.

- After 5 wrong tries the PIN pad waits 30 seconds, and longer after each new wrong try.
- If you forget the PIN, press **Parent** on the kid screen, then **I forgot my PIN**, and type the recovery code you wrote down at setup. You then get a new code.
- The PIN is a family lock, not a safe. Someone with an administrator account on this computer can get around it, for example by deleting the app's data. Settings and scene lists are signed, so changes made outside the app are noticed and a movie stops counting as protected until you review it again. Keep the administrator account for grown-ups.

## Privacy {#privacy}

- bonis oculis has no account, no ads and no statistics, and it never connects to the internet.
- Pictures of flagged scenes are blurred before they are saved. A clear picture is never written to disk.
- Your library, reviews and settings stay in the app's folder on this computer. Files are only shared when you press an export button.
