# yt-music-cleaner

A personal tool to clean up your YouTube playlists (including YouTube Music playlists) by removing deleted, private, unavailable, or duplicate videos.

## Features

- **Automated YouTube OAuth 2.0 Flow**: Briefly spins up a local web server (on port `3000`) and opens your default browser for authorization.
- **Token Caching**: Caches authorization tokens locally in `token.json` so you only authenticate once.
- **Unavailable Video Detection**: Batches checks against the official YouTube Data API v3 to identify deleted, private, and inaccessible videos.
- **Duplicate Video Detection**: Scans the playlist to identify subsequent occurrences of duplicate videos.
- **Interactive Deletion**: Displays a summary of findings and allows cleaning up duplicates, deleted/unavailable videos, or both.

## Prerequisites

- Node.js (v16+)
- A Google Cloud Console project with the **YouTube Data API v3** enabled.
- OAuth 2.0 client credentials (downloaded as a JSON file).

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/noishey/yt-music-cleaner.git
   cd yt-music-cleaner
   ```
2. Install dependencies:
   ```bash
   npm install
   ```

## Configuration

1. Place your Google Cloud OAuth 2.0 client credentials JSON file in the root of the project directory. The filename should start with `client_secret_` and end with `.json` (e.g. `client_secret_xxxx.apps.googleusercontent.com.json`).
2. Make sure your OAuth client configuration in Google Cloud Console has `http://localhost` or `http://localhost:3000` added as an **Authorized redirect URI**.

## Usage

Run the tool:
```bash
node index.js
```

1. **Authentication**: If you are running the tool for the first time, your browser will open to authenticate with Google. Log in and authorize the requested YouTube scopes.
2. **Playlist Selection**: The terminal will list your playlists. Select one by entering its number, or enter a custom playlist ID directly.
3. **Scan**: The tool will scan the playlist and present a summary of deleted/unavailable and duplicate videos.
4. **Clean**: Choose to clean up unavailable videos, duplicate videos, or both.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
