#!/bin/bash

# BASE URL (Update for your Render URL)
URL="https://driverflow-backend.onrender.com"
# For local testing use:
# URL="http://localhost:3000"

echo "1. REGISTER (Expect 201 + require_email_verification: true)"
curl -X POST "$URL/register" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "driver",
    "nombre": "Juan Perez",
    "contacto": "juan@test.com",
    "password": "Password123!",
    "confirm_password": "Password123!",
    "tipo_licencia": "A"
  }'

echo -e "\n\n2. LOGIN UNVERIFIED (Expect 403 EMAIL_NOT_VERIFIED)"
curl -X POST "$URL/login" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "driver",
    "contacto": "juan@test.com",
    "password": "Password123!"
  }'

echo -e "\n\n3. RESEND VERIFICATION (Expect 200)"
curl -X POST "$URL/resend_verification" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "driver",
    "contact": "juan@test.com"
  }'

echo -e "\n\n4. VERIFY EMAIL (Replace TOKEN with actual token from logs/email)"
curl -X POST "$URL/verify_email" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "REPLACE_WITH_TOKEN"
  }'
