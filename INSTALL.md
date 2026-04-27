# MRV Assistant — Install & Use

This is the install guide written exactly per PRD v4 Part 13. If the steps
here ever disagree with the PRD, the PRD wins.

## Install (one-time, ~2 minutes)

1. Download the `mrv-assistant.zip` file.
2. Unzip it — you get a folder called `mrv-assistant`.
3. Open Chrome → go to `chrome://extensions`.
4. Turn on **Developer mode** (toggle, top right).
5. Click **Load unpacked** → select the `mrv-assistant` folder.
6. The MRV Assistant icon appears in the Chrome toolbar.

## To use (every patient)

1. Open Maximus, open a patient C-file.
2. Search your keywords in Maximus as normal — type each one and press Enter
   so the cyan highlights appear. (The extension cannot type these for you.)
3. Click the MRV Assistant icon in the Chrome toolbar.
4. Select the **DBQ type** for this evaluation.
5. Click **Run Highlight Extraction**.
6. Wait for it to finish (watch the progress bar).
7. Open the Sticky Notes panel in Maximus to jump to flagged pages.

## If notes land on wrong pages

Open the extension, change **Speed** to **Slow**, and run again on a new
patient. Slow mode waits longer between scrolls and clicks.

## What the extension will and will not do

It places a yellow **HI-PRI** sticky note on pages where your keywords match
the DBQ type, and an orange **REVIEW** note on pages where the match is
weaker. Each note shows the matched keywords, page number, and today's date.

It does **not** read the actual medical text on the page — the document is
rendered as an image inside SVG, and there is no selectable text. You still
read each flagged page yourself; the extension just gets you there fast.

It does **not** add search keywords for you, store patient data, or send
anything outside Chrome. All state lives locally.
