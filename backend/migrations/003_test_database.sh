#!/bin/sh
# Creates stockflow_test with the same schema and no seed data, so `go test`
# never touches the database the app runs against.
set -e
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE stockflow_test"
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d stockflow_test -f /docker-entrypoint-initdb.d/001_schema.sql
