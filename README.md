# Lyrics Display

Your multitrack/DAW sends MIDI (or OSC) to this program on a computer. Phones on the same Wi‑Fi open a web page and show the current lyric line in large white text on black. No app install on the phones, no animation.

```
DAW ──MIDI or OSC──▶ server.js (computer) ──Wi‑Fi──▶ phone browsers
```

## 1. Install

1. Install Node.js 18 or newer from nodejs.org.
2. In this folder run `npm install` (this adds QR codes and MIDI support; if MIDI fails to install, OSC and manual control still work).
3. Run `npm start`. On Windows you can instead double-click `start.bat`: it installs what's needed on first run, uses the settings written at the top of the file, and restarts the program by itself if it ever stops. Right-click `start.bat` and choose Edit to change the settings.

The window prints the address to open on the phones, for example `http://192.168.1.20:8080`. The operator page is the same address plus `/control`, and the QR code page for the congregation is the same address plus `/join`.

If phones can’t connect, allow Node.js through the computer’s firewall and make sure the phones are on the same network (not cellular data). A dedicated router for the band is the most reliable setup.

## 2. Add songs

Put song files in the `songs` folder, named with a number first. You can mix three kinds:

```
songs/01 Opening Song.pro     ProPresenter 7 file
songs/02 Ballad.pro6          ProPresenter 6 file
songs/03 Closer.txt           plain text, one lyric line per line
```

**ProPresenter files:** copy them out of your ProPresenter library (on a Mac usually `Documents/ProPresenter/Libraries/Default`, on Windows `Documents\ProPresenter\Libraries\Default`) and add the song number to the front of the name. Each slide becomes one step, in the order of the song’s selected arrangement (or group order if no arrangement is selected). A two-line slide shows as two lines on the phones, and the group name (Verse 1, Chorus…) shows at the top. Slide notes, media-only cues and disabled slides are left out. Blank slides are kept so the numbering matches the arrangement.

If you change the arrangement or edit the song in ProPresenter, copy the file again; the program picks up changes the next time the song is selected.

You can also point the program straight at a ProPresenter library with `SONGS_DIR`, but then songs are numbered by alphabetical order, which changes whenever you add a song. A set folder with numbered copies is more predictable.

**Text files:** one lyric line per text line. Blank lines and lines starting with `#` are skipped.

The control page lists every song with the MIDI note number for each line or slide, plus the section name.

## 3. Wire up the DAW (MIDI)

**Mac:** `npm start` creates a MIDI port called **Lyrics Display**. Pick it as the output of a MIDI track in your DAW.

**Linux:** same as Mac (virtual ALSA port).

**Windows:** install loopMIDI (free), create a port, set your DAW’s MIDI track to output to it, then start with the port name:

```
set MIDI_PORT=loopMIDI Port
npm start
```

(You can also use `MIDI_PORT` on Mac to listen to an existing port such as the IAC Driver.)

### What to put on the MIDI track

| MIDI message | Action |
|---|---|
| Program Change 1, 2, 3… | Select song 01, 02, 03… |
| Note On, note number N | Show line or slide N of the current song |
| Note On, note 0 | Blank the screen (shows the first line as a preview underneath) |
| CC 20 / CC 21 / CC 22 | Next line / previous line / blank |
| CC 23 | Show the welcome page |

Put a Program Change at the start of each song and a short note at the moment each line should appear. Using the line number as the note means jumping around the timeline always lands on the right line at the next note. Note numbers are shown as numbers in the control page; DAWs name note 60 as either C3 or C4, so check your DAW’s convention when placing notes.

Set `MIDI_CHANNEL=16` (for example) to listen to only one channel.

### More than 128 songs (banks)

Program Change only reaches 128 songs. Turn on banks with `MIDI_BANKS=yes` (in `start.bat`, or as a setting) and send **CC 0** with the bank number just before each Program Change:

| CC 0 (bank) | Program Change | Song |
|---|---|---|
| 0 | 1–128 | 1–128 |
| 1 | 1–128 | 129–256 |
| 2 | 1–128 | 257–384 |

The bank stays set until the next CC 0, so with banks on, put a CC 0 before *every* Program Change, including songs in bank 0; otherwise a song can load from the previous song's bank. In MultiTracks Playback, add a CC cue (controller 0, value = bank) a moment before the PC cue so they arrive in that order. The control page shows the bank and program for every song.

With banks off (the default), CC 0 is ignored and songs above 128 can only be chosen from the control page or OSC.

## 4. OSC (optional)

UDP port 9000 (change with `OSC_PORT`). Addresses:

| Address | Argument |
|---|---|
| `/lyrics/song` | song number |
| `/lyrics/line` | line number (0 = blank) |
| `/lyrics/next`, `/lyrics/prev`, `/lyrics/clear`, `/lyrics/welcome` | none (a value of 0 is ignored, so buttons work) |
| `/lyrics/text` | any text to show on all phones |

## Phones

- The section name (Verse 1, Chorus…) from ProPresenter files shows next to the song title.
- Tap A− / A+ to change text size; “Hide next” removes the grey preview of the upcoming line. Settings are saved per phone.
- The dot at the top left is green when connected. The page reconnects by itself after Wi‑Fi drops.
- Set each phone’s auto-lock to “Never” (or a long time) during the show; browsers only allow pages to keep the screen on when served over HTTPS.

## Welcome page

When the program starts, phones show a welcome page instead of lyrics. It stays up, even when a song is selected, until the first lyric line appears (a note above 0, Next, or custom text). Bring it back any time with the control page’s “Show welcome” button, MIDI CC 23 (for example at the end of the last song), or OSC `/lyrics/welcome`.

Edit `welcome.txt` in Notepad to change the wording: the first line is the heading, the lines after it are the message.

## vMix overlay (transparent background)

`/overlay` shows only the current lyric, in white outlined text on a transparent background, for keying over video in vMix (or OBS). It shows nothing during the welcome page or a blank screen.

1. In vMix: **Add Input → Web Browser**.
2. URL: `http://localhost:8080/overlay` if vMix runs on the same PC as the lyrics program, otherwise `http://<lyrics PC address>:8080/overlay`.
3. Width 1920, Height 1080 (or your output size).
4. Put the input on an **Overlay** channel over your camera or program feed.

Options are added to the address, for example `http://localhost:8080/overlay?pos=bottom&size=1.2&box=1`:

| Option | Values | Default |
|---|---|---|
| `pos` | `bottom`, `center`, `top` | `bottom` |
| `size` | text size multiplier, e.g. `0.8`, `1.5` | `1` |
| `box` | `1` = dark see-through panel behind the text | `0` (outlined text) |
| `next` | `1` = also show the next line, smaller | `0` |
| `align` | `center`, `left` | `center` |
| `margin` | distance from the top/bottom edge, % of the height | `8` |
| `title` | `1` = show the song title with each song’s first line | `0` |

Lyrics change instantly with no animation; use vMix’s overlay transition if you want a fade in and out.

## Join page with QR codes

Open `/join` on the projector (or print it for the bulletin). It shows a QR code that opens the lyrics, and, if you set the Wi‑Fi name, a second QR code that joins the phone to your Wi‑Fi first. On Windows use `set NAME=value` before `npm start`; on Mac/Linux:

```
WIFI_SSID="Church Guest" WIFI_PASSWORD="welcome123" npm start
```

Give the computer a reserved IP address in your router so the QR code stays the same every week. If the computer has several network connections and the code shows the wrong address, set `PUBLIC_URL=http://192.168.1.20:8080`.

## Large congregations

Every phone keeps one small connection open and receives about 200 bytes per lyric change, so the program itself handles hundreds or thousands of phones. The Wi‑Fi is the limit:

- A home router manages roughly 30–50 phones. Business access points manage about 100–200 each; use several, spread around the room, on the same network.
- Guest networks often block phones from reaching other devices (“client isolation”). Connect the computer by cable where guests can reach it, or allow its address.

## Internet relay (optional)

With the relay, phones can use mobile data, and your Wi‑Fi carries almost no lyric traffic. The church computer sends each change once to a small cloud server; phones connect to that server instead.

1. Put this folder on any host that runs Node.js 18+ (a small VPS, or a platform such as Render, Railway or Fly.io). Start command: `node relay.js`. The host sets `PORT`; set `RELAY_TOKEN` to a long random secret.
2. Use the HTTPS address the host gives you. HTTPS also lets phones keep their screens on.
3. On the church computer, start with the relay address and the same secret, and point the join page at the relay:

```
RELAY_URL=https://your-relay.example.org RELAY_TOKEN=your-long-secret PUBLIC_URL=https://your-relay.example.org npm start
```

The local address keeps working at the same time, so phones on church Wi‑Fi can use either. If the internet drops, the window says so and local phones carry on; the relay catches up within 30 seconds of the connection returning. `https://your-relay…/health` shows how many phones are connected.

## Settings

All optional, set as environment variables: `HTTP_PORT` (8080), `OSC_PORT` (9000), `MIDI_PORT`, `MIDI_CHANNEL`, `SONGS_DIR`, `PUBLIC_URL`, `WIFI_SSID`, `WIFI_PASSWORD`, `WIFI_SECURITY` (WPA, WEP or nopass), `RELAY_URL`, `RELAY_TOKEN`. CC numbers can be changed at the top of `server.js`.
