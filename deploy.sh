#!/usr/bin/env bash

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}====================================================${NC}"
echo -e "${GREEN} Vertex AI OpenAI Proxy - Cloud Run Deployment ${NC}"
echo -e "${BLUE}====================================================${NC}"


# ----------------------------------------------------
# 1. Check gcloud
# ----------------------------------------------------

if ! command -v gcloud &> /dev/null; then
    echo -e "${RED}gcloud CLI missing${NC}"
    exit 1
fi


# ----------------------------------------------------
# 2. Project
# ----------------------------------------------------

PROJECT_ID=$(gcloud config get-value project 2>/dev/null)

if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" == "(unset)" ]; then
    read -p "Enter Project ID: " PROJECT_ID
    gcloud config set project "$PROJECT_ID"
fi

echo "Using project: $PROJECT_ID"


REGION="us-central1"
SERVICE_NAME="vertex-openai-proxy"

SA_NAME="vertex-admin-sa"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

KEY_FILE="key.json"


# ----------------------------------------------------
# 3. Enable APIs
# ----------------------------------------------------

echo -e "\n${BLUE}[1/6] Enabling APIs${NC}"


gcloud services enable \
    aiplatform.googleapis.com \
    run.googleapis.com \
    firestore.googleapis.com \
    iam.googleapis.com \
    cloudbuild.googleapis.com \
    artifactregistry.googleapis.com \
    compute.googleapis.com \
    --project="$PROJECT_ID"



# ----------------------------------------------------
# 4. Restore Google Service Accounts
# ----------------------------------------------------

echo -e "\n${BLUE}[2/6] Restoring Google service identities${NC}"


PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" \
    --format="value(projectNumber)")


COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
CLOUDBUILD_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
RUN_AGENT="service-${PROJECT_NUMBER}@serverless-robot-prod.iam.gserviceaccount.com"


echo "Project Number: $PROJECT_NUMBER"


echo "Creating Compute service identity..."

gcloud beta services identity create \
    --service=compute.googleapis.com \
    --project="$PROJECT_ID" \
    || true


echo "Creating Cloud Build service identity..."

gcloud beta services identity create \
    --service=cloudbuild.googleapis.com \
    --project="$PROJECT_ID" \
    || true


echo "Creating Cloud Run service identity..."

gcloud beta services identity create \
    --service=run.googleapis.com \
    --project="$PROJECT_ID" \
    || true



# ----------------------------------------------------
# 5. Restore IAM permissions
# ----------------------------------------------------

echo -e "\n${BLUE}[3/6] Restoring IAM permissions${NC}"


grant_role () {

    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="$1" \
        --role="$2" \
        --quiet \
        || true

}


echo "Cloud Build permissions..."

grant_role \
"serviceAccount:$CLOUDBUILD_SA" \
"roles/cloudbuild.builds.builder"


grant_role \
"serviceAccount:$COMPUTE_SA" \
"roles/cloudbuild.builds.builder"


grant_role \
"serviceAccount:$COMPUTE_SA" \
"roles/storage.admin"

echo "Granting Compute default SA permissions..."

grant_role \
"serviceAccount:$COMPUTE_SA" \
"roles/cloudbuild.builds.builder"


# Required for Cloud Run source upload bucket access
grant_role \
"serviceAccount:$COMPUTE_SA" \
"roles/storage.objectViewer"


# Required for Cloud Run build source bucket operations
grant_role \
"serviceAccount:$COMPUTE_SA" \
"roles/storage.objectAdmin"


echo "Cloud Run service agent..."

grant_role \
"serviceAccount:$RUN_AGENT" \
"roles/run.serviceAgent"

echo -e "\n${BLUE}[3/6] Restoring IAM permissions${NC}"


grant_role () {

    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="$1" \
        --role="$2" \
        --quiet \
        || true

}


echo "Cloud Build permissions..."

grant_role \
"serviceAccount:$CLOUDBUILD_SA" \
"roles/cloudbuild.builds.builder"


echo "Compute default service account permissions..."

grant_role \
"serviceAccount:$COMPUTE_SA" \
"roles/cloudbuild.builds.builder"


grant_role \
"serviceAccount:$COMPUTE_SA" \
"roles/storage.objectViewer"


grant_role \
"serviceAccount:$COMPUTE_SA" \
"roles/storage.objectAdmin"


echo "Cloud Run service agent..."

grant_role \
"serviceAccount:$RUN_AGENT" \
"roles/run.serviceAgent"

# ----------------------------------------------------
# 6. Firestore
# ----------------------------------------------------

echo -e "\n${BLUE}[4/6] Firestore setup${NC}"


if ! gcloud firestore databases describe \
    --project="$PROJECT_ID" &>/dev/null; then

    echo "Creating Firestore database..."

    gcloud firestore databases create \
        --location="$REGION" \
        --type=firestore-native \
        --project="$PROJECT_ID" \
        || true

else
    echo "Firestore already exists"
fi



# ----------------------------------------------------
# 7. Runtime Service Account
# ----------------------------------------------------

echo -e "\n${BLUE}[5/6] Runtime service account${NC}"


if ! gcloud iam service-accounts describe "$SA_EMAIL" \
    --project="$PROJECT_ID" &>/dev/null; then


    echo "Creating $SA_NAME..."

    gcloud iam service-accounts create "$SA_NAME" \
        --display-name="Vertex OpenAI Proxy Runtime SA" \
        --project="$PROJECT_ID"

fi



echo "Assigning runtime roles..."


RUNTIME_ROLES=(

"roles/aiplatform.user"

"roles/datastore.owner"

"roles/logging.logWriter"

"roles/monitoring.metricWriter"

"roles/run.invoker"

)


for ROLE in "${RUNTIME_ROLES[@]}"
do

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SA_EMAIL" \
    --role="$ROLE" \
    --quiet \
    || true

done



# ----------------------------------------------------
# 8. Local key (optional)
# ----------------------------------------------------

echo "Creating local key.json if missing..."

if [ ! -f "$KEY_FILE" ]; then

gcloud iam service-accounts keys create "$KEY_FILE" \
    --iam-account="$SA_EMAIL" \
    --project="$PROJECT_ID"

else

echo "key.json already exists"

fi



# ----------------------------------------------------
# 9. Environment
# ----------------------------------------------------

echo -e "\n${BLUE}[6/6] Creating environment${NC}"


JWT_SECRET=$(openssl rand -hex 32)

ENCRYPTION_KEY=$(openssl rand -hex 32)

DEFAULT_ADMIN_PASSWORD=$(openssl rand -hex 8)


cat > .env <<EOF

PORT=3000

GOOGLE_CLOUD_PROJECT_ID=$PROJECT_ID

GOOGLE_CLOUD_LOCATION=$REGION

GOOGLE_CLOUD_MODEL_ID=gemini-2.5-pro


DEFAULT_ADMIN_EMAIL=admin@$PROJECT_ID

DEFAULT_ADMIN_PASSWORD=$DEFAULT_ADMIN_PASSWORD


JWT_SECRET=$JWT_SECRET

ENCRYPTION_KEY=$ENCRYPTION_KEY

EOF



# ----------------------------------------------------
# 10. Deploy Cloud Run
# ----------------------------------------------------

echo -e "\n${BLUE}Deploying Cloud Run${NC}"


gcloud run deploy "$SERVICE_NAME" \
    --source . \
    --region "$REGION" \
    --platform managed \
    --allow-unauthenticated \
    --service-account="$SA_EMAIL" \
    --set-env-vars="GOOGLE_CLOUD_PROJECT_ID=$PROJECT_ID,GOOGLE_CLOUD_LOCATION=$REGION,GOOGLE_CLOUD_MODEL_ID=gemini-2.5-pro,DEFAULT_ADMIN_EMAIL=admin@$PROJECT_ID,DEFAULT_ADMIN_PASSWORD=$DEFAULT_ADMIN_PASSWORD,JWT_SECRET=$JWT_SECRET,ENCRYPTION_KEY=$ENCRYPTION_KEY" \
    --project="$PROJECT_ID"



SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --format="value(status.url)")


echo -e "\n${GREEN}====================================================${NC}"
echo -e "${GREEN}DEPLOYMENT COMPLETE${NC}"
echo -e "${GREEN}====================================================${NC}"

echo "URL:"
echo "$SERVICE_URL"

echo ""
echo "Admin:"
echo "Email: admin@$PROJECT_ID"
echo "Password: $DEFAULT_ADMIN_PASSWORD"

echo ""
echo "OpenAI Compatible Endpoint:"
echo "$SERVICE_URL/v1"

echo -e "${GREEN}====================================================${NC}"
