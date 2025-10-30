## Alma Order It! Chrome Extension (Brandeis Library)

This is a Chrome extension to send order information from Amazon, Abebooks, or Kanopy
directly into Alma via the Acquisitions API.

## Features:
- Automatically scrapes book or video data from vendor pages
- Defaults material type and PO line type based on vendor page
- Lets users fill in fund, reporting code, and interested users, and change prepopulated fields
- Allows for multiple physical copies to be ordered, receiving notes to be sent, and interested users to be added
- For Kanopy, automatically adds licensing and ID information to the receiving note
- Encrypts and stores Alma API keys securely
- Creates Alma PO lines directly via API

## Supported Vendors
- Amazon
- Kanopy
- AbeBooks

## Installation
1. Download or clone this repository:
   ```bash
   git clone https://github.com/Brandeis-Library/Alma-Order-Extension.git
2. Open Chrome → Extensions → Manage Extensions.

3. Enable Developer mode.

4. Click Load unpacked and select this folder.

## Setup
1. Open the Options page of the extension.

2. Set your password (remember it!) and unlock the options page.

3. Set the Alma API key.

4. Test the connection.

5. You should be good to go!
