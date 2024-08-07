#!/bin/bash

APP_NAME=""

# Function to display usage
usage() {
    echo "Usage: $0 --app-name heroku-app-name"
    exit 1
}

# Parse named command line arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --app-name) APP_NAME="$2"; shift ;;
        *) echo "Unknown parameter passed: $1"; usage; exit 1 ;;
    esac
    shift
done

# Verify required arguments
if [ -z "$APP_NAME" ]; then
    usage
fi

# Drop existing tables and create new ones
heroku pg:psql --app "$APP_NAME" <<EOF
DROP TABLE IF EXISTS messages;
CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    role VARCHAR(255),
    content TEXT,
    guide VARCHAR(255),
    companion VARCHAR(255),
    thread VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DROP TABLE IF EXISTS companions;
CREATE TABLE companions (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255),
    address VARCHAR(255) UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DROP TABLE IF EXISTS contacts;
CREATE TABLE contacts (
    id SERIAL PRIMARY KEY,
    contact VARCHAR(255),
    address VARCHAR(255),
    companion VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DROP INDEX IF EXISTS idx_messages_guide;
CREATE INDEX idx_messages_guide ON messages(guide);

DROP INDEX IF EXISTS idx_messages_companion;
CREATE INDEX idx_messages_companion ON messages(companion);

DROP INDEX IF EXISTS idx_messages_thread;
CREATE INDEX idx_messages_thread ON messages(thread);

DROP TABLE IF EXISTS "session";
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
) WITH (OIDS=FALSE);
ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;

DROP TABLE IF EXISTS prompts;
CREATE TABLE IF NOT EXISTS prompts (
  id SERIAL PRIMARY KEY,
  account TEXT NOT NULL,
  prompt TEXT NOT NULL,
  timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (account)
);
EOF

echo "Database tables created successfully."
