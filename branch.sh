#!/bin/bash

BRANCH_NAME=""
OPENAI_API_KEY=""
SESSION_SECRET=""
NEXT_PUBLIC_PRIVY_APP_ID=""
FILE_PATHS=""

# Function to display usage
usage() {
    echo "Usage: $0 --name branch-name --openai-key YOUR-OPENAI-API-KEY --session-secret YOUR-SESSION-SECRET --privy PRIVY-APP-ID --files \"path1 path2 path3\""
    exit 1
}

# Parse named command line arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --name) BRANCH_NAME="$2"; shift ;;
        --openai-key) OPENAI_API_KEY="$2"; shift ;;
        --session-secret) SESSION_SECRET="$2"; shift ;;
        --privy) NEXT_PUBLIC_PRIVY_APP_ID="$2"; shift ;;
        --files) FILE_PATHS="$2"; shift ;;
        *) echo "Unknown parameter passed: $1"; usage; exit 1 ;;
    esac
    shift
done

# Verify required arguments
if [ -z "$BRANCH_NAME" ] || [ -z "$OPENAI_API_KEY" ] || [ -z "$SESSION_SECRET" ] || [ -z "$NEXT_PUBLIC_PRIVY_APP_ID" ]; then
    usage
fi

# Install dependencies
yarn

# Login to Heroku
heroku login

# Create a new branch
git checkout -b $BRANCH_NAME

# Update the branch name in sensei.json
jq --arg branch "$BRANCH_NAME" '.branch = $branch' sensei.json > temp.json && mv temp.json sensei.json

# Add the updated sensei.json to the staging area
git add sensei.json

# Commit the change with a message
git commit -m "update branch name in sensei.json to $BRANCH_NAME"

# Add the specified files to the files directory
mkdir -p files # Ensure the files directory exists
IFS=',' read -r -a filePathArray <<< "$FILE_PATHS"
for filePath in "${filePathArray[@]}"; do
    cp "$filePath" files/
done
echo "Copied specified files to the files directory."

# Add the copied files to git, commit, and continue as before
git add files/*
git commit -m "Added specific files to the files directory."

# Create a new Heroku app
heroku create $BRANCH_NAME

# Add the Node.js buildpack to your Heroku application
heroku buildpacks:add --index 1 heroku/nodejs --app "$BRANCH_NAME"

# Add the FFmpeg buildpack to your Heroku application
heroku buildpacks:add --index 1 https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest.git --app "$BRANCH_NAME"

# Set Heroku config variables
heroku config:set OPENAI_API_KEY="$OPENAI_API_KEY" --app "$BRANCH_NAME"
heroku config:set SESSION_SECRET="$SESSION_SECRET" --app "$BRANCH_NAME"
heroku config:set NEXT_PUBLIC_PRIVY_APP_ID="$NEXT_PUBLIC_PRIVY_APP_ID" --app "$BRANCH_NAME"

# Add logging with Logtail free plan
heroku addons:create logtail:free --app $BRANCH_NAME

# Deploy a Postgres database under the Essentials 0 plan
heroku addons:create heroku-postgresql:essential-0 --app $BRANCH_NAME

# Wait five minutes for the database to be provisioned
sleep 300

# Call the new createDatabase.sh script to set up the database tables
./createDatabase.sh --app-name "$BRANCH_NAME"

# Add Heroku remote for this branch
git remote add $BRANCH_NAME https://git.heroku.com/$BRANCH_NAME.git

# Push the branch to Heroku
git push $BRANCH_NAME $BRANCH_NAME:main

# Open the Heroku app in a browser
heroku open --app $BRANCH_NAME
