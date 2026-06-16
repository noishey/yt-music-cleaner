require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const url = require('url');
const readline = require('readline');
const { exec } = require('child_process');
const { google } = require('googleapis');

const TOKEN_PATH = path.join(__dirname, 'token.json');
const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}`;

// Helper to ask user questions in the terminal
function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => rl.question(query, (ans) => {
    rl.close();
    resolve(ans.trim());
  }));
}

// Find Google OAuth client secret JSON in current directory
function findClientSecretFile() {
  const files = fs.readdirSync(__dirname);
  const secretFile = files.find(f => f.startsWith('client_secret_') && f.endsWith('.json'));
  if (!secretFile) {
    throw new Error('Could not find client_secret_*.json file in the current directory. Please download it from Google Cloud Console.');
  }
  return path.join(__dirname, secretFile);
}

// Load client secrets from file
function loadClientCredentials() {
  const secretPath = findClientSecretFile();
  console.log(`Using client secret file: ${path.basename(secretPath)}`);
  const content = fs.readFileSync(secretPath, 'utf8');
  const credentials = JSON.parse(content);
  const key = credentials.installed || credentials.web;
  if (!key) {
    throw new Error('Client secret file is invalid or not formatted as "installed" or "web" OAuth credentials.');
  }
  return {
    clientId: key.client_id,
    clientSecret: key.client_secret,
  };
}

// Authenticate and get OAuth client
async function getOAuthClient() {
  const { clientId, clientSecret } = loadClientCredentials();
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  // Check if we have previously stored tokens
  if (fs.existsSync(TOKEN_PATH)) {
    const token = fs.readFileSync(TOKEN_PATH, 'utf8');
    oauth2Client.setCredentials(JSON.parse(token));
    return oauth2Client;
  }

  // Otherwise, trigger the interactive OAuth flow
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = url.parse(req.url, true);
        if (reqUrl.pathname === '/') {
          const code = reqUrl.query.code;
          if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<h1>Error</h1><p>No authorization code found in the query parameters.</p>');
            return;
          }

          // Exchange authorization code for tokens
          const { tokens } = await oauth2Client.getToken(code);
          oauth2Client.setCredentials(tokens);
          
          // Save tokens for future executions
          fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
          console.log(`\nAuthorization successful! Tokens saved to ${path.basename(TOKEN_PATH)}`);

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h1>Success!</h1><p>Authentication was successful. You can close this browser tab and return to your terminal.</p>');
          
          // Close server and resolve client
          server.close();
          resolve(oauth2Client);
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<h1>Authentication Failed</h1><p>See console logs for details.</p>');
        server.close();
        reject(err);
      }
    });

    server.listen(PORT, () => {
      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
          'https://www.googleapis.com/auth/youtube',
          'https://www.googleapis.com/auth/youtube.readonly'
        ],
        prompt: 'consent' // Forces Google to supply a refresh token
      });

      console.log('\n================================================================');
      console.log('AUTHORIZATION REQUIRED');
      console.log('================================================================');
      console.log('Opening your browser to authenticate with your YouTube account...');
      console.log('If the browser does not open automatically, visit this URL:');
      console.log(authUrl);
      console.log('================================================================\n');

      // Attempt to open default browser automatically
      exec(`open "${authUrl}"`, (err) => {
        if (err) {
          console.log('(Please open the URL manually above if it did not launch automatically)');
        }
      });
    });
  });
}

// Fetch all playlists owned by the authenticated user
async function listPlaylists(youtube) {
  let playlists = [];
  let nextPageToken = null;
  console.log('Retrieving your playlists...');
  
  do {
    const res = await youtube.playlists.list({
      part: 'snippet,contentDetails',
      mine: true,
      maxResults: 50,
      pageToken: nextPageToken,
    });
    
    if (res.data.items) {
      playlists.push(...res.data.items);
    }
    nextPageToken = res.data.nextPageToken;
  } while (nextPageToken);
  
  return playlists;
}

// Retrieve all items in a playlist
async function getPlaylistItems(youtube, playlistId) {
  let items = [];
  let nextPageToken = null;
  process.stdout.write('Fetching playlist items...');
  
  do {
    const res = await youtube.playlistItems.list({
      part: 'snippet,contentDetails,status',
      playlistId: playlistId,
      maxResults: 50,
      pageToken: nextPageToken,
    });
    
    if (res.data.items) {
      items.push(...res.data.items);
    }
    nextPageToken = res.data.nextPageToken;
    process.stdout.write('.');
  } while (nextPageToken);
  
  console.log(` Done! Found ${items.length} items.`);
  return items;
}

// Check status of videos in batches of 50 to see if they are deleted or private (unavailable)
async function verifyVideosAvailability(youtube, videoIds) {
  const existingVideos = new Map();
  const uniqueIds = Array.from(new Set(videoIds));
  process.stdout.write('Verifying video statuses via YouTube API...');
  
  for (let i = 0; i < uniqueIds.length; i += 50) {
    const batch = uniqueIds.slice(i, i + 50);
    const res = await youtube.videos.list({
      part: 'snippet,status',
      id: batch.join(','),
    });
    
    if (res.data.items) {
      for (const item of res.data.items) {
        existingVideos.set(item.id, item);
      }
    }
    process.stdout.write('.');
  }
  
  console.log(' Done!');
  return existingVideos;
}

// Delete playlist items by playlistItemId
async function deletePlaylistItems(youtube, playlistItemIds, itemsMap) {
  console.log(`\nStarting deletion of ${playlistItemIds.length} items...`);
  
  for (let i = 0; i < playlistItemIds.length; i++) {
    const itemId = playlistItemIds[i];
    const itemInfo = itemsMap.get(itemId);
    const title = itemInfo ? itemInfo.snippet.title : 'Unknown Title';
    const videoId = itemInfo ? itemInfo.contentDetails.videoId : 'Unknown ID';
    
    console.log(`[${i + 1}/${playlistItemIds.length}] Deleting: "${title}" (Video ID: ${videoId})...`);
    
    try {
      await youtube.playlistItems.delete({
        id: itemId,
      });
      // Sleep briefly to avoid aggressive hitting of YouTube API quota limits
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error(`Error deleting item ${itemId}:`, err.message || err);
    }
  }
  console.log('\nAll deletion operations finished!');
}

async function main() {
  try {
    const client = await getOAuthClient();
    const youtube = google.youtube({ version: 'v3', auth: client });

    // Step 1: List and select a playlist
    const playlists = await listPlaylists(youtube);
    if (playlists.length === 0) {
      console.log('No playlists found in your account.');
      return;
    }

    console.log('\nYour Playlists:');
    playlists.forEach((pl, index) => {
      console.log(`[${index + 1}] ${pl.snippet.title} (${pl.contentDetails.itemCount} items)`);
    });
    console.log(`[${playlists.length + 1}] Enter a custom Playlist ID directly`);

    const selectionIndexStr = await askQuestion(`\nSelect a playlist (1-${playlists.length + 1}): `);
    const selectionIndex = parseInt(selectionIndexStr, 10);

    let playlistId = '';
    let playlistTitle = '';

    if (isNaN(selectionIndex) || selectionIndex < 1 || selectionIndex > playlists.length + 1) {
      console.log('Invalid selection.');
      return;
    }

    if (selectionIndex === playlists.length + 1) {
      playlistId = await askQuestion('Enter YouTube Playlist ID: ');
      playlistTitle = `Custom Playlist (${playlistId})`;
    } else {
      const selected = playlists[selectionIndex - 1];
      playlistId = selected.id;
      playlistTitle = selected.snippet.title;
    }

    console.log(`\nScanning Playlist: "${playlistTitle}" (${playlistId})`);

    // Step 2: Get all items in the playlist
    const items = await getPlaylistItems(youtube, playlistId);
    if (items.length === 0) {
      console.log('This playlist is empty.');
      return;
    }

    // Map item.id -> item for logging references
    const itemsMap = new Map();
    items.forEach(item => itemsMap.set(item.id, item));

    // Step 3: Analyze videos
    const videoIds = items.map(item => item.contentDetails?.videoId).filter(Boolean);
    const existingVideosMap = await verifyVideosAvailability(youtube, videoIds);

    const duplicates = [];
    const unavailable = [];
    const seenVideoIds = new Set();

    for (const item of items) {
      const videoId = item.contentDetails?.videoId;
      if (!videoId) {
        // No videoId in contentDetails implies deleted/unavailable immediately
        unavailable.push(item);
        continue;
      }

      // Check duplicates
      if (seenVideoIds.has(videoId)) {
        duplicates.push(item);
      } else {
        seenVideoIds.add(videoId);
      }

      // Check availability (deleted or private videos)
      // If the video is not present in the videos.list response, it's unavailable.
      // Or if its snippet title matches 'Deleted video' or 'Private video' placeholders
      const videoDetails = existingVideosMap.get(videoId);
      const title = item.snippet?.title || '';
      
      const isPlaceholder = title.toLowerCase() === 'deleted video' || title.toLowerCase() === 'private video';
      const isMissingFromApi = !videoDetails;

      if (isPlaceholder || isMissingFromApi) {
        unavailable.push(item);
      }
    }

    // Step 4: Display findings
    console.log('\n================================================================');
    console.log('SCAN SUMMARY');
    console.log('================================================================');
    console.log(`Total Videos Checked:         ${items.length}`);
    console.log(`Deleted/Unavailable Videos:  ${unavailable.length}`);
    console.log(`Duplicate Videos:             ${duplicates.length}`);
    console.log('================================================================');

    if (unavailable.length > 0) {
      console.log('\nDeleted/Unavailable Videos found:');
      unavailable.forEach((item, idx) => {
        console.log(`  - [${idx + 1}] "${item.snippet.title}" (Video ID: ${item.contentDetails?.videoId || 'N/A'}, Playlist Item ID: ${item.id})`);
      });
    }

    if (duplicates.length > 0) {
      console.log('\nDuplicate Videos found (subsequent occurrences):');
      duplicates.forEach((item, idx) => {
        console.log(`  - [${idx + 1}] "${item.snippet.title}" (Video ID: ${item.contentDetails?.videoId}, Playlist Item ID: ${item.id})`);
      });
    }

    if (unavailable.length === 0 && duplicates.length === 0) {
      console.log('\nCongratulations! Your playlist is clean. No action needed.');
      return;
    }

    // Step 5: Choose what to clean
    console.log('\nCleaning Options:');
    console.log('[1] Delete Deleted/Unavailable videos only');
    console.log('[2] Delete Duplicate videos only');
    console.log('[3] Delete BOTH Deleted/Unavailable and Duplicate videos');
    console.log('[4] Cancel (Exit without deleting)');

    const actionStr = await askQuestion('\nChoose an action (1-4): ');
    const action = parseInt(actionStr, 10);

    let itemsToDelete = [];

    if (action === 1) {
      itemsToDelete = unavailable;
    } else if (action === 2) {
      itemsToDelete = duplicates;
    } else if (action === 3) {
      // Use a Set to ensure unique playlistItemIds in case an item is both duplicate and unavailable
      const uniqueDeleteIds = new Set();
      unavailable.forEach(item => uniqueDeleteIds.add(item.id));
      duplicates.forEach(item => uniqueDeleteIds.add(item.id));
      
      itemsToDelete = Array.from(uniqueDeleteIds).map(id => itemsMap.get(id));
    } else {
      console.log('Operation cancelled. Exiting.');
      return;
    }

    if (itemsToDelete.length === 0) {
      console.log('No items selected for deletion.');
      return;
    }

    const confirm = await askQuestion(`\nAre you sure you want to delete ${itemsToDelete.length} items from your playlist? (yes/no): `);
    if (confirm.toLowerCase() === 'yes' || confirm.toLowerCase() === 'y') {
      await deletePlaylistItems(youtube, itemsToDelete.map(item => item.id), itemsMap);
    } else {
      console.log('Deletion cancelled.');
    }

  } catch (err) {
    console.error('\nAn error occurred:', err.message || err);
  }
}

main();
