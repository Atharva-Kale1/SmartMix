import pandas as pd
import numpy as np
import os
import sys
import warnings
import re
from sklearn.preprocessing import StandardScaler
from sklearn.metrics.pairwise import cosine_similarity

# --- CONFIGURATION ---
n_mfcc_features = 5
# Weights for each feature group (tune as needed)
MFCC_WEIGHT = 0.4
CHROMA_WEIGHT = 0.2
TEMPO_WEIGHT = 0.4

# Suppress warnings
warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", category=SyntaxWarning)

# --- HELPER FUNCTIONS ---

def normalize_song_name(name):
    """Normalize song name for better matching"""
    if not isinstance(name, str):
        return ""
    # Remove content in parentheses, brackets, special characters, and extra spaces
    name = re.sub(r'[\(\[].*?[\)\]]', '', name)  # Remove content in parentheses/brackets
    name = re.sub(r'[^\w\s]', '', name)  # Remove special characters
    name = name.lower().strip()  # Convert to lowercase and trim
    name = re.sub(r'\s+', ' ', name)  # Replace multiple spaces with single space
    return name

def find_best_crossfade_from_match(target_song_name, df, similarity_matrix):
    """
    Finds and returns the best song name to crossfade INTO from a target song.
    Returns None if no suitable match is found.
    """
    try:
        print(f"DEBUG: Searching for target song: '{target_song_name}'", file=sys.stderr)
        
        # Normalize the target song name
        normalized_target = normalize_song_name(target_song_name)
        print(f"DEBUG: Normalized target: '{normalized_target}'", file=sys.stderr)
        
        # Get all normalized song names from CSV
        df_normalized = df['filename'].apply(normalize_song_name)
        print(f"DEBUG: First 10 normalized CSV songs: {df_normalized.head(10).tolist()}", file=sys.stderr)
        
        # Try to find the best match
        best_match_idx = -1
        best_match_score = 0
        
        for idx, csv_song_normalized in enumerate(df_normalized):
            # Calculate similarity score (simple string matching)
            if normalized_target in csv_song_normalized or csv_song_normalized in normalized_target:
                score = 1.0
            else:
                # Use sequence matching for partial matches
                target_words = set(normalized_target.split())
                csv_words = set(csv_song_normalized.split())
                common_words = target_words.intersection(csv_words)
                score = len(common_words) / max(len(target_words), 1)
            
            if score > best_match_score:
                best_match_score = score
                best_match_idx = idx
        
        if best_match_idx == -1 or best_match_score < 0.3:
            print(f"ERROR: No suitable match found for '{target_song_name}' (best score: {best_match_score})", file=sys.stderr)
            return None
        
        print(f"DEBUG: Best match found at index {best_match_idx} with score {best_match_score}", file=sys.stderr)
        print(f"DEBUG: Original CSV name: '{df.iloc[best_match_idx]['filename']}'", file=sys.stderr)
        
        target_song_idx = best_match_idx
        similarities = similarity_matrix[target_song_idx, :]
        
        # Get top 5 matches for debugging
        similar_indices = similarities.argsort()[::-1]
        print(f"DEBUG: Top 5 similar songs:", file=sys.stderr)
        for i, idx in enumerate(similar_indices[:5]):
            if idx != target_song_idx:
                similarity_score = similarities[idx]
                print(f"  {i+1}. '{df.iloc[idx]['filename']}' - score: {similarity_score:.4f}", file=sys.stderr)

        # Find the top match that is not the song itself
        for idx in similar_indices:
            if idx != target_song_idx:
                match_filename = df.iloc[idx]['filename']
                print(f"DEBUG: Selected match: '{match_filename}'", file=sys.stderr)
                return match_filename

        print("ERROR: No suitable match found (only self-match available)", file=sys.stderr)
        return None

    except Exception as e:
        print(f"ERROR in find_best_crossfade_from_match: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return None

# --- MAIN RECOMMENDATION LOGIC ---

def main():
    """Main function to load data and run the recommendation engine."""
    
    # Check for both song name and CSV file path arguments
    if len(sys.argv) < 3:
        print("Usage: python recommendation_engine.py <song_name> <csv_file_path>", file=sys.stderr)
        sys.exit(1)

    target_song_name = sys.argv[1]
    input_csv_file = sys.argv[2]

    print(f"DEBUG: Starting recommendation for '{target_song_name}'", file=sys.stderr)
    print(f"DEBUG: CSV file path: '{input_csv_file}'", file=sys.stderr)

    # Load data
    if not os.path.exists(input_csv_file):
        print(f"ERROR: The file '{input_csv_file}' does not exist.", file=sys.stderr)
        sys.exit(1)

    try:
        df_final = pd.read_csv(input_csv_file)
        print(f"DEBUG: Loaded CSV with {len(df_final)} rows", file=sys.stderr)
        
        # Check if required columns exist
        required_columns = ['filename', 'mfcc_start', 'chroma_start', 'mfcc_end', 'chroma_end', 'tempo_start', 'tempo_end']
        missing_columns = [col for col in required_columns if col not in df_final.columns]
        if missing_columns:
            print(f"ERROR: Missing columns in CSV: {missing_columns}", file=sys.stderr)
            sys.exit(1)
            
        # Convert stringified features back to numpy arrays/floats
        df_final['mfcc_start'] = df_final['mfcc_start'].apply(lambda x: np.array([float(val) for val in x.strip('[]').split(',')]))
        df_final['chroma_start'] = df_final['chroma_start'].apply(lambda x: np.array([float(val) for val in x.strip('[]').split(',')]))
        df_final['mfcc_end'] = df_final['mfcc_end'].apply(lambda x: np.array([float(val) for val in x.strip('[]').split(',')]))
        df_final['chroma_end'] = df_final['chroma_end'].apply(lambda x: np.array([float(val) for val in x.strip('[]').split(',')]))
        
        print("DEBUG: Successfully parsed feature columns", file=sys.stderr)

    except Exception as e:
        print(f"ERROR loading or parsing the CSV file: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)

    # Reshape features and scale them
    try:
        mfcc_start_matrix = np.vstack(df_final['mfcc_start'].values)
        mfcc_end_matrix = np.vstack(df_final['mfcc_end'].values)
        chroma_start_matrix = np.vstack(df_final['chroma_start'].values)
        chroma_end_matrix = np.vstack(df_final['chroma_end'].values)

        scaler = StandardScaler()
        mfcc_start_scaled = scaler.fit_transform(mfcc_start_matrix)
        mfcc_end_scaled = scaler.fit_transform(mfcc_end_matrix)
        chroma_start_scaled = scaler.fit_transform(chroma_start_matrix)
        chroma_end_scaled = scaler.fit_transform(chroma_end_matrix)

        # Calculate individual similarity matrices
        mfcc_similarity = cosine_similarity(mfcc_end_scaled, mfcc_start_scaled)
        chroma_similarity = cosine_similarity(chroma_end_scaled, chroma_start_scaled)

        # Calculate tempo similarity
        df_tempo = df_final[['tempo_start', 'tempo_end']].copy()
        tempo_matrix = np.abs(df_tempo.values[:, 1].reshape(-1, 1) - df_tempo.values[:, 0].reshape(1, -1))
        tempo_similarity = 1 - (tempo_matrix / (tempo_matrix.max() + 1e-8))  # Avoid division by zero

        # Combine matrices using weights
        similarity_matrix = (MFCC_WEIGHT * mfcc_similarity) + \
                            (CHROMA_WEIGHT * chroma_similarity) + \
                            (TEMPO_WEIGHT * tempo_similarity)

        print("DEBUG: Successfully calculated similarity matrix", file=sys.stderr)

    except Exception as e:
        print(f"ERROR in feature processing: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)

    # Find and print the best recommendation to standard output (stdout)
    recommended_song_name = find_best_crossfade_from_match(target_song_name, df_final, similarity_matrix)
    if recommended_song_name:
        print(recommended_song_name)
    else:
        print("ERROR: Recommendation engine could not find a suitable song name.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()