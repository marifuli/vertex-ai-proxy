#!/usr/bin/env bash

set -e

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}====================================================${NC}"
echo -e "${GREEN} Vertex AI OpenAI Proxy - Cloud Run Deployment ${NC}"
echo -e "${BLUE}====================================================${NC}"

# 1. Check gcloud CLI
if ! command -v gcloud &> /dev/null; then
    echo -e "${RED}Error: gcloud CLI is not installed.${NC}"
    echo "Please install Google Cloud SDK or run this script inside Google Cloud Shell."
    exit 1
fi

# 2. Identify Project ID
PROJECT_ID=$(gcloud config get-value project 2>/dev/null)

if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" == "(unset)" ]; then
    echo -e "${YELLOW}No active GCP project detected.${NC}"
    read -p "Please enter your GCP Project ID: " PROJECT_ID
    gcloud config set project "$PROJECT_ID"
else
    echo -e "Using active GCP Project ID: ${GREEN}${PROJECT_ID}${NC}"
fi

rm .gitignore
rm .git 

REGION="us-central1"
SERVICE_NAME="vertex-openai-proxy"
SA_NAME="vertex-admin-sa"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
KEY_FILE="key.json"

# 3. Enable GCP Services
echo -e "\n${BLUE}[1/5] Enabling required Google Cloud APIs...${NC}"
gcloud services enable \
    aiplatform.googleapis.com \
    run.googleapis.com \
    firestore.googleapis.com \
    iam.googleapis.com \
    cloudbuild.googleapis.com \
    artifactregistry.googleapis.com \
    --project="$PROJECT_ID"

# 4. Ensure Firestore Database Exists
echo -e "\n${BLUE}[2/5] Setting up Firestore database...${NC}"
if ! gcloud firestore databases describe --project="$PROJECT_ID" &>/dev/null; then
    echo "Creating Firestore database in Native mode..."
    gcloud firestore databases create --location="$REGION" --type=firestore-native --project="$PROJECT_ID" || true
else
    echo -e "${GREEN}Firestore database already exists.${NC}"
fi

# 5. Create Service Account and Key
echo -e "\n${BLUE}[3/5] Setting up Service Account and Credentials...${NC}"
if ! gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT_ID" &>/dev/null; then
    echo "Creating Service Account: $SA_NAME..."
    gcloud iam service-accounts create "$SA_NAME" \
        --display-name="Vertex OpenAI Proxy Admin SA" \
        --project="$PROJECT_ID"
else
    echo "Service Account $SA_NAME already exists."
fi

echo "Assigning IAM roles to Service Account..."
ROLES=(
    "roles/aiplatform.user"
    "roles/datastore.owner"
    "roles/iam.serviceAccountTokenCreator"
    "roles/editor"
)

for ROLE in "${ROLES[@]}"; do
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:$SA_EMAIL" \
        --role="$ROLE" \
        --quiet &>/dev/null || true
done

echo "Generating Service Account key.json..."
gcloud iam service-accounts keys create "$KEY_FILE" \
    --iam-account="$SA_EMAIL" \
    --project="$PROJECT_ID"

echo -e "${GREEN}✓ Created and saved ${KEY_FILE}${NC}"

# 6. Generate Environment Secrets
echo -e "\n${BLUE}[4/5] Preparing environment configuration...${NC}"
JWT_SECRET=$(openssl rand -hex 32 2>/dev/null || echo "jwt_secret_$(date +%s)_$RANDOM")
ENCRYPTION_KEY=$(openssl rand -hex 32 2>/dev/null || echo "enc_key_$(date +%s)_$RANDOM")
DEFAULT_ADMIN_PASSWORD=$(openssl rand -hex 8 2>/dev/null || echo "admin123456")
DEFAULT_ADMIN_EMAIL="admin@${PROJECT_ID}.iam.gserviceaccount.com"

# Update/Create local .env file
cat <<EOF > .env
PORT=3000
GOOGLE_CLOUD_PROJECT_ID=${PROJECT_ID}
GOOGLE_CLOUD_LOCATION=${REGION}
GOOGLE_CLOUD_MODEL_ID=gemini-2.5-pro
GOOGLE_APPLICATION_CREDENTIALS=./key.json
DEFAULT_ADMIN_EMAIL=${DEFAULT_ADMIN_EMAIL}
DEFAULT_ADMIN_PASSWORD=${DEFAULT_ADMIN_PASSWORD}
JWT_SECRET=${JWT_SECRET}
ENCRYPTION_KEY=${ENCRYPTION_KEY}
EOF

# 7. Deploy to Cloud Run
echo -e "\n${BLUE}[5/5] Deploying project to Cloud Run...${NC}"
gcloud run deploy "$SERVICE_NAME" \
    --source . \
    --region="$REGION" \
    --platform=managed \
    --allow-unauthenticated \
    --service-account="$SA_EMAIL" \
    --set-env-vars="GOOGLE_CLOUD_PROJECT_ID=${PROJECT_ID},GOOGLE_CLOUD_LOCATION=${REGION},GOOGLE_CLOUD_MODEL_ID=gemini-2.5-pro,GOOGLE_APPLICATION_CREDENTIALS=./key.json,DEFAULT_ADMIN_EMAIL=${DEFAULT_ADMIN_EMAIL},DEFAULT_ADMIN_PASSWORD=${DEFAULT_ADMIN_PASSWORD},JWT_SECRET=${JWT_SECRET},ENCRYPTION_KEY=${ENCRYPTION_KEY}" \
    --project="$PROJECT_ID"

# Get Cloud Run URL
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --project="$PROJECT_ID" --format="value(status.url)")

echo -e "\n${GREEN}====================================================${NC}"
echo -e "${GREEN}       DEPLOYMENT COMPLETED SUCCESSFULLY!           ${NC}"
echo -e "${GREEN}====================================================${NC}"
echo -e "Cloud Run Base URL: ${BLUE}${SERVICE_URL}${NC}"
echo -e "OpenAI Proxy Base Endpoint: ${BLUE}${SERVICE_URL}/v1${NC}"
echo -e "Admin Panel URL: ${BLUE}${SERVICE_URL}${NC}"
echo -e "\nDefault Admin Login:"
echo -e "  Email: ${YELLOW}${DEFAULT_ADMIN_EMAIL}${NC}"
echo -e "  Password: ${YELLOW}${DEFAULT_ADMIN_PASSWORD}${NC}"
echo -e "===================================================="
echo -e "\nUse this in OpenCode / Kilo Code / Cursor / Cline:"
echo -e "  Base URL: ${BLUE}${SERVICE_URL}/v1${NC}"
echo -e "  API Key: Create an API key via Admin UI or use proxy authentication"
echo -e "====================================================\n"
