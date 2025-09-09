# SmartFade

SmartFade is a music recommendation application that leverages Spotify's API and machine learning to provide personalized song recommendations. It features a web-based frontend for user interaction and a backend powered by Node.js and Python.

## Features

- **Recommendation Engine**: Uses machine learning (scikit-learn) to analyze song data and provide the best match recommendations.
- **Spotify Integration**: Connects to Spotify API for song data and queue management.
- **Web Interface**: Simple HTML client for getting recommendations and displaying results.
- **Session Management**: Secure user sessions with express-session.

## Prerequisites

- Node.js (v14 or higher)
- Python (v3.7 or higher)
- Spotify Premium Account (required for queueing songs)
- Spotify Developer Account (to obtain API credentials)

## Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd smartfade
   ```

2. Install Node.js dependencies:
   ```bash
   npm install
   ```

3. Install Python dependencies:
   ```bash
   pip install -r requirements.txt
   ```

4. Set up environment variables:
   Create a `.env` file in the root directory with your Spotify API credentials:
   ```
   SPOTIFY_CLIENT_ID=your_client_id
   SPOTIFY_CLIENT_SECRET=your_client_secret
   SPOTIFY_REDIRECT_URI=http://localhost:3000/callback
   ```

## Usage

1. Start the server:
   ```bash
   npm start
   ```

2. Open your browser and navigate to `http://localhost:3000` to access the client interface.

3. Use the "Get Recommendation" button to receive personalized song recommendations.

## Important Note

**You should be a premium user to run this application**, as it requires Spotify Premium features for queueing songs and full API access.

## Project Structure

- `index.js`: Main Express server with Spotify API integration
- `client.html`: Frontend interface
- `recommendation_engine.py`: Python-based recommendation engine using pandas and scikit-learn
- `final_features_data_with_uri.csv`: Dataset for song features
- `Dockerfile`: Docker configuration for containerization

## License

This project is licensed under the ISC License.
