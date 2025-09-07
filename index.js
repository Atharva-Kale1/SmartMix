const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'my-super-secret-key-that-no-one-will-guess',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set to true in production with HTTPS
}));

// --- Spotify API Credentials from .env ---
const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
const redirectUri = process.env.SPOTIFY_REDIRECT_URI;
const scopes = 'user-read-playback-state user-modify-playback-state user-read-private';

// In-memory store for tokens (REPLACE with a database for production)
const userTokens = {};

// --- Function to get the Python executable path ---
function getPythonExecutable() {
    const userPath = process.env.PYTHON_EXECUTABLE;
    if (userPath) {
        console.log(`Using Python executable from .env: ${userPath}`);
        return userPath;
    }
    const pythonExecutables = ['python3', 'python', 'py'];
    for (const exec of pythonExecutables) {
        try {
            const { spawnSync } = require('child_process');
            const result = spawnSync(exec, ['--version'], { encoding: 'utf-8' });
            if (result.status === 0) {
                console.log(`Found Python executable at: ${exec}`);
                return exec;
            }
        } catch (error) {
            continue;
        }
    }
    throw new Error('Python executable not found. Please ensure Python is installed and added to your system\'s PATH.');
}

// --- 1. Login/Authentication Endpoint ---
app.get('/login', (req, res) => {
    console.log('Redirecting to Spotify for authentication...');
    const authUrl = `https://accounts.spotify.com/authorize?client_id=${clientId}&response_type=code&redirect_uri=${redirectUri}&scope=${encodeURIComponent(scopes)}`;
    res.redirect(authUrl);
});

// --- 2. Callback Endpoint ---
app.get('/callback', async (req, res) => {
    const code = req.query.code || null;
    if (!code) {
        return res.status(400).json({ error: 'Authorization code not provided.' });
    }

    try {
        const authOptions = {
            url: 'https://accounts.spotify.com/api/token',
            method: 'post',
            params: {
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: redirectUri,
            },
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
            },
        };

        const response = await axios(authOptions);
        const newAccessToken = response.data.access_token;
        const newRefreshToken = response.data.refresh_token;

        // Get the user's Spotify profile to find their ID
        const profileResponse = await axios.get('https://api.spotify.com/v1/me', {
            headers: { 'Authorization': `Bearer ${newAccessToken}` }
        });
        const spotifyUserId = profileResponse.data.id;
        
        // Store tokens and user ID in the session and in-memory store
        req.session.userId = spotifyUserId;
        userTokens[spotifyUserId] = {
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
            expiresAt: Date.now() + (response.data.expires_in * 1000)
        };

        console.log(`Authentication successful for user: ${profileResponse.data.display_name}!`);
        // Redirect the user back to the main page
        res.redirect('/');

    } catch (error) {
        console.error('Error during token exchange:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to authenticate with Spotify.' });
    }
});

// New endpoint to check authentication status
app.get('/auth-status', (req, res) => {
    if (req.session.userId && userTokens[req.session.userId]) {
        res.status(200).send('Authenticated');
    } else {
        res.status(401).send('Not Authenticated');
    }
});

// New logout endpoint
app.get('/logout', (req, res) => {
    if (req.session.userId) {
        delete userTokens[req.session.userId];
        req.session.destroy();
    }
    res.redirect('/');
});


// Middleware to check and refresh tokens for all protected endpoints
app.use(async (req, res, next) => {
    const userId = req.session.userId;
    if (!userId || !userTokens[userId]) {
        return res.status(401).json({ error: 'Please log in first. Navigate to /login to authorize.' });
    }

    const user = userTokens[userId];
    const now = Date.now();

    if (user.expiresAt < now) {
        try {
            console.log(`Token expired for user ${userId}. Refreshing...`);
            const authOptions = {
                url: 'https://accounts.spotify.com/api/token',
                method: 'post',
                params: {
                    grant_type: 'refresh_token',
                    refresh_token: user.refreshToken,
                },
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
                },
            };
            const refreshResponse = await axios(authOptions);

            user.accessToken = refreshResponse.data.access_token;
            user.expiresAt = now + (refreshResponse.data.expires_in * 1000);
            
            console.log(`Access token refreshed successfully for user: ${userId}.`);
        } catch (error) {
            console.error('Failed to refresh token:', error.response?.data || error.message);
            req.session.destroy();
            return res.status(401).json({ error: 'Session expired. Please log in again.' });
        }
    }
    req.accessToken = user.accessToken;
    next();
});

// --- Serve the HTML file for the root path ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'client.html'));
});

// --- Debug endpoint to check CSV contents ---
app.get('/debug-csv', (req, res) => {
    const csvFilePath = path.join(__dirname, 'final_features_data_with_uri.csv');
    
    if (!fs.existsSync(csvFilePath)) {
        return res.status(404).json({ error: `CSV file not found at: ${csvFilePath}` });
    }

    const results = [];
    fs.createReadStream(csvFilePath)
        .pipe(require('csv-parser')())
        .on('data', (data) => results.push(data))
        .on('end', () => {
            res.json({
                totalSongs: results.length,
                sampleSongs: results.slice(0, 10).map(r => r.filename),
                filePath: csvFilePath
            });
        });
});

// --- New Endpoint to get a recommendation and queue it ---
app.get('/recommend-and-queue', async (req, res) => {
    const accessToken = req.accessToken;

    let currentSongName = null;
    let recommendedSongName = null;
    let bestMatch = null;

    try {
        const response = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (response.status === 204 || !response.data.item) {
            return res.status(404).json({ message: 'No song is currently playing on an active device.' });
        }

        currentSongName = response.data.item.name;
        console.log(`Current song is: ${currentSongName}`);

        const cleanedSongName = currentSongName.replace(/\s*\(.*\)/, '').trim();
        console.log(`Searching for: ${cleanedSongName}`);

        let pythonExecutable;
        try {
            pythonExecutable = getPythonExecutable();
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }

        const pythonScriptPath = path.join(__dirname, 'recommendation_engine.py');
        const csvFilePath = path.join(__dirname, 'final_features_data_with_uri.csv');

        // Check if files exist
        if (!fs.existsSync(pythonScriptPath)) {
            return res.status(500).json({ error: `Python script not found at: ${pythonScriptPath}` });
        }
        if (!fs.existsSync(csvFilePath)) {
            return res.status(500).json({ error: `CSV file not found at: ${csvFilePath}` });
        }

        console.log(`Running Python script: ${pythonExecutable} "${pythonScriptPath}" "${cleanedSongName}" "${csvFilePath}"`);

        recommendedSongName = await new Promise((resolve, reject) => {
            const pythonProcess = spawn(pythonExecutable, [
                `"${pythonScriptPath}"`,
                `"${cleanedSongName}"`,
                `"${csvFilePath}"`
            ], {
                shell: true,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let output = '';
            let errorOutput = '';

            pythonProcess.stdout.on('data', (data) => {
                const dataStr = data.toString();
                output += dataStr;
                console.log(`Python stdout: ${dataStr.trim()}`);
            });

            pythonProcess.stderr.on('data', (data) => {
                const dataStr = data.toString();
                errorOutput += dataStr;
                console.error(`Python stderr: ${dataStr.trim()}`);
            });

            pythonProcess.on('close', (code) => {
                console.log(`Python process exited with code ${code}`);
                console.log(`Python output: '${output.trim()}'`);
                console.log(`Python error output: '${errorOutput.trim()}'`);

                if (code !== 0) {
                    return reject(new Error(`Python process failed with code ${code}. Error: ${errorOutput}`));
                }

                const trimmedOutput = output.trim();
                if (!trimmedOutput) {
                    return reject(new Error('Recommendation engine returned no output.'));
                }

                // Check for a specific error message from the Python script
                if (trimmedOutput.toLowerCase().includes('song not found') || trimmedOutput.startsWith('ERROR:')) {
                    return reject(new Error(`Python script error: ${trimmedOutput}`));
                }

                resolve(trimmedOutput);
            });

            pythonProcess.on('error', (err) => {
                console.error('Python process error:', err);
                reject(err);
            });

            setTimeout(() => {
                if (!pythonProcess.killed) {
                    pythonProcess.kill();
                    reject(new Error('Python process timeout after 30 seconds'));
                }
            }, 30000);
        });

        console.log(`Recommended song name: ${recommendedSongName}`);

        const cleanRecommendedName = recommendedSongName.replace(/\.mp3$/i, '').trim();
        console.log(`Cleaned recommended name: ${cleanRecommendedName}`);

        const searchResponse = await axios.get(`https://api.spotify.com/v1/search?q=${encodeURIComponent(cleanRecommendedName)}&type=track&limit=5`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        const tracks = searchResponse.data.tracks.items;
        if (!tracks || tracks.length === 0) {
            return res.status(404).json({ error: `Could not find any tracks for the recommended song: ${cleanRecommendedName}.` });
        }

        let bestScore = 0;
        const normalizedRecommended = cleanRecommendedName.toLowerCase();

        for (const track of tracks) {
            const trackName = track.name.toLowerCase();
            let score = 0;

            if (trackName === normalizedRecommended) {
                score = 1.0;
            } else if (trackName.includes(normalizedRecommended) || normalizedRecommended.includes(trackName)) {
                score = 0.8;
            } else {
                const recommendedWords = new Set(normalizedRecommended.split(/\s+/));
                const trackWords = new Set(trackName.split(/\s+/));
                const commonWords = new Set([...recommendedWords].filter(word => trackWords.has(word)));
                score = commonWords.size / Math.max(recommendedWords.size, 1);
            }

            if (score > bestScore) {
                bestScore = score;
                bestMatch = track;
            }
        }

        if (!bestMatch) {
            return res.status(404).json({ error: `Could not find a suitable track among search results for: ${recommendedSongName}` });
        }

        console.log(`Best match: ${bestMatch.name} by ${bestMatch.artists[0].name} (score: ${bestScore})`);
        const recommendedSongUri = bestMatch.uri;

        await axios.post(`https://api.spotify.com/v1/me/player/queue?uri=${recommendedSongUri}`, {}, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        res.status(200).json({
            message: `Recommended song "${bestMatch.name}" added to queue successfully!`,
            uri: recommendedSongUri,
            bestMatchName: bestMatch.name,
            track: {
                name: bestMatch.name,
                artist: bestMatch.artists.map(a => a.name).join(', '),
                album: bestMatch.album.name
            }
        });

    } catch (error) {
        let songNameInError = 'the recommended song';
        if (bestMatch && bestMatch.name) {
            songNameInError = bestMatch.name;
        } else if (recommendedSongName) {
            songNameInError = recommendedSongName;
        }

        console.error('Error adding recommended song to queue:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({
            error: `Failed to add "${songNameInError}" to queue. Ensure you are a Premium user and have an active device playing music. Error details: ${error.message}`
        });
    }
});
// --- 4. Get Current Song Endpoint ---
app.get('/current-song', async (req, res) => {
    const accessToken = req.accessToken;

    try {
        const response = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (response.status === 204) {
            return res.status(200).json({ message: 'No song is currently playing.' });
        }

        const track = response.data.item;
        if (track) {
            res.json({
                title: track.name,
                artist: track.artists.map(a => a.name).join(', '),
                album: track.album.name,
                uri: track.uri,
                albumArt: track.album.images[0]?.url || null
            });
        } else {
            res.status(404).json({ error: 'No track data found.' });
        }
    } catch (error) {
        console.error('Error fetching current song:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({ error: 'Failed to get current song.' });
    }
});

// --- 5. Queue a Random Song Endpoint ---
app.post('/queue-random-song', async (req, res) => {
    const accessToken = req.accessToken;

    try {
        const randomChar = String.fromCharCode(97 + Math.floor(Math.random() * 26));
        const searchResponse = await axios.get(`https://api.spotify.com/v1/search?q=${randomChar}&type=track&limit=1`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        const track = searchResponse.data.tracks.items[0];
        if (!track) {
            return res.status(404).json({ error: 'Could not find a random song.' });
        }

        const uri = track.uri;

        const queueResponse = await axios.post(`https://api.spotify.com/v1/me/player/queue?uri=${uri}`, {}, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (queueResponse.status === 204) {
            res.status(200).json({
                message: `Successfully added "${track.name}" by "${track.artists[0].name}" to the queue.`,
                track: {
                    title: track.name,
                    artist: track.artists[0].name
                }
            });
        } else {
            res.status(queueResponse.status).json({ error: 'Failed to add song to queue.' });
        }

    } catch (error) {
        console.error('Error queuing random song:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({ error: 'Failed to queue a random song. Make sure you are a Premium user and have an active device playing music.' });
    }
});

// --- 6. Refresh Token Endpoint (for future use) ---
app.get('/refresh-token', async (req, res) => {
    const userId = req.session.userId;
    if (!userId || !userTokens[userId]) {
        return res.status(401).json({ error: 'No refresh token available. Please log in first.' });
    }
    
    try {
        const authOptions = {
            url: 'https://accounts.spotify.com/api/token',
            method: 'post',
            params: {
                grant_type: 'refresh_token',
                refresh_token: userTokens[userId].refreshToken,
            },
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
            },
        };

        const response = await axios(authOptions);
        userTokens[userId].accessToken = response.data.access_token;
        console.log('Access token refreshed successfully.');
        res.status(200).json({ message: 'Access token refreshed successfully.' });

    } catch (error) {
        console.error('Error refreshing token:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to refresh token.' });
    }
});

const port = process.env.PORT || 8888;
app.listen(port, () => {
    console.log('==========================================');
    console.log(`Spotify Server running on port ${port}!`);
    console.log('👉 Go to /login to authenticate with Spotify');
    console.log('👉 Debug endpoints:');
    console.log('   - /debug-csv - Check CSV contents');
    console.log('   - /current-song - Get current playing song');
    console.log('==========================================');
});
