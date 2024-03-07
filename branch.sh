#!/bin/bash

# Initialize variables
BRANCH_NAME=""
OPENAI_API_KEY=""
SESSION_SECRET=""

# Function to display usage
usage() {
    echo "Usage: $0 --name branch-name --openai-key YOUR-OPENAI-API-KEY --session-secret YOUR-SESSION-SECRET"
    exit 1
}

# Parse command line options
while getopts ":n:k:s:" opt; do
  case ${opt} in
    n )
      BRANCH_NAME=$OPTARG
      ;;
    k )
      OPENAI_API_KEY=$OPTARG
      ;;
    s )
      SESSION_SECRET=$OPTARG
      ;;
    \? )
      usage
      ;;
  esac
done
shift $((OPTIND -1))

# Check if all options were provided
if [ -z "${BRANCH_NAME}" ] || [ -z "${OPENAI_API_KEY}" ] || [ -z "${SESSION_SECRET}" ]; then
    usage
fi

# Create a new branch
git checkout -b $BRANCH_NAME

# Update the branch name in sensei.json
jq --arg branch "$BRANCH_NAME" '.branch = $branch' sensei.json > temp.json && mv temp.json sensei.json

# Add the updated sensei.json to the staging area
git add sensei.json

# Commit the change with a message
git commit -m "update branch name in sensei.json to $BRANCH_NAME"

# Create a new Heroku app
heroku create $BRANCH_NAME

# Set Heroku config variables
heroku config:set OPENAI_API_KEY="$OPENAI_API_KEY" --app "$BRANCH_NAME"
heroku config:set SESSION_SECRET="$SESSION_SECRET" --app "$BRANCH_NAME"

# Add logging with Logtail free plan
heroku addons:create logtail:free --app $BRANCH_NAME

# Deploy a Postgres database under the basic plan
heroku addons:create heroku-postgresql:basic --app $BRANCH_NAME

# Create a database table to store messages
heroku pg:psql --app "$BRANCH_NAME" <<EOF
CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    role VARCHAR(255),
    content TEXT,
    guide VARCHAR(255),
    companion VARCHAR(255),
    thread VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
EOF

# Create a database table to store companions (accounts that send queries, could be human or AI)
heroku pg:psql --app "$BRANCH_NAME" <<EOF
CREATE TABLE companions (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255),
    hashedpassword VARCHAR(255),
    address VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
EOF

# Index messages by guide, companion, and thread for easy retrieval
heroku pg:psql --app "$BRANCH_NAME" <<EOF
CREATE INDEX idx_messages_guide ON messages(guide);
CREATE INDEX idx_messages_companion ON messages(companion);
CREATE INDEX idx_messages_thread ON messages(thread);
EOF

# Create a table to store sessions
heroku pg:psql --app "$BRANCH_NAME" <<EOF
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
) WITH (OIDS=FALSE);
ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
EOF

# Add Heroku remote for this branch
git remote add $BRANCH_NAME https://git.heroku.com/$BRANCH_NAME.git

# Push the branch to Heroku
git push $BRANCH_NAME $BRANCH_NAME:main

# Open the Heroku app in a browser
heroku open --app $BRANCH_NAME