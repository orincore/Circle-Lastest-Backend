// ============================================
// Circle Backend - Jenkins CI/CD Pipeline
// Zero-Downtime Rolling Deployment
// ============================================

pipeline {
    agent any

    environment {
        // Docker Registry (Update with your Docker Hub username)
        DOCKER_REGISTRY = credentials('docker-registry-name')
        DOCKER_TAG = "${env.BUILD_NUMBER}-${env.GIT_COMMIT?.take(7) ?: 'latest'}"
        PREVIOUS_TAG = "previous"
        
        // Service Images
        API_IMAGE = "${DOCKER_REGISTRY}/circle-api"
        SOCKET_IMAGE = "${DOCKER_REGISTRY}/circle-socket"
        MATCHMAKING_IMAGE = "${DOCKER_REGISTRY}/circle-matchmaking"
        CRON_IMAGE = "${DOCKER_REGISTRY}/circle-cron"
        
        // Paths (Jenkins checks out repo root where Dockerfiles live)
        BACKEND_DIR = "."
    }

    options {
        timeout(time: 45, unit: 'MINUTES')
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '20', artifactNumToKeepStr: '10'))
        timestamps()
    }
    
    parameters {
        booleanParam(name: 'SKIP_TESTS', defaultValue: false, description: 'Skip tests during build')
        booleanParam(name: 'FORCE_REBUILD', defaultValue: false, description: 'Force rebuild without cache')
        booleanParam(name: 'DEPLOY_AFTER_BUILD', defaultValue: true, description: 'Automatically deploy to server after pushing images')
    }

    stages {
        // ============================================
        // Stage 1: Checkout & Prepare
        // ============================================
        stage('Checkout') {
            steps {
                checkout scm
                script {
                    env.GIT_COMMIT_MSG = sh(
                        script: 'git log -1 --pretty=%B',
                        returnStdout: true
                    ).trim()
                }
            }
        }

        // ============================================
        // Stage 2: Install Dependencies & Test
        // ============================================
        stage('Install & Test') {
            steps {
                dir(BACKEND_DIR) {
                    sh '''
                        echo "� Current directory: $(pwd)"
                        echo "📂 Directory contents:"
                        ls -la
                        echo ""
                        echo "�� Installing dependencies..."
                        npm ci --prefer-offline --no-audit
                        
                        if [ "${SKIP_TESTS}" != "true" ]; then
                            echo "🔍 Running linter..."
                            npm run lint || echo "⚠️ Linting warnings found"
                            
                            # echo "🧪 Running tests..."
                            # npm test  # Uncomment when tests are ready
                        else
                            echo "⏭️ Skipping tests as requested"
                        fi
                    '''
                }
            }
        }
        // ============================================
        // Stage 3: Build All Docker Images (Parallel)
        // ============================================
        stage('Build Docker Images') {
            parallel {
                stage('Build API') {
                    steps {
                        dir(BACKEND_DIR) {
                            sh '''
                                echo "🏗️ Building API image..."
                                CACHE_FLAG="--cache-from ${API_IMAGE}:latest"
                                if [ "${FORCE_REBUILD}" = "true" ]; then
                                    CACHE_FLAG="--no-cache"
                                fi
                                
                                docker build \
                                    -f docker/Dockerfile.api \
                                    -t ${API_IMAGE}:${DOCKER_TAG} \
                                    -t ${API_IMAGE}:latest \
                                    $CACHE_FLAG \
                                    --build-arg BUILDKIT_INLINE_CACHE=1 \
                                    --label "build.number=${BUILD_NUMBER}" \
                                    --label "git.commit=${GIT_COMMIT}" \
                                    .
                            '''
                        }
                    }
                }
                stage('Build Socket') {
                    steps {
                        dir(BACKEND_DIR) {
                            sh '''
                                echo "🏗️ Building Socket image..."
                                CACHE_FLAG="--cache-from ${SOCKET_IMAGE}:latest"
                                if [ "${FORCE_REBUILD}" = "true" ]; then
                                    CACHE_FLAG="--no-cache"
                                fi
                                
                                docker build \
                                    -f docker/Dockerfile.socket \
                                    -t ${SOCKET_IMAGE}:${DOCKER_TAG} \
                                    -t ${SOCKET_IMAGE}:latest \
                                    $CACHE_FLAG \
                                    --build-arg BUILDKIT_INLINE_CACHE=1 \
                                    --label "build.number=${BUILD_NUMBER}" \
                                    --label "git.commit=${GIT_COMMIT}" \
                                    .
                            '''
                        }
                    }
                }
                stage('Build Matchmaking') {
                    steps {
                        dir(BACKEND_DIR) {
                            sh '''
                                echo "🏗️ Building Matchmaking image..."
                                CACHE_FLAG="--cache-from ${MATCHMAKING_IMAGE}:latest"
                                if [ "${FORCE_REBUILD}" = "true" ]; then
                                    CACHE_FLAG="--no-cache"
                                fi
                                
                                docker build \
                                    -f docker/Dockerfile.matchmaking \
                                    -t ${MATCHMAKING_IMAGE}:${DOCKER_TAG} \
                                    -t ${MATCHMAKING_IMAGE}:latest \
                                    $CACHE_FLAG \
                                    --build-arg BUILDKIT_INLINE_CACHE=1 \
                                    --label "build.number=${BUILD_NUMBER}" \
                                    --label "git.commit=${GIT_COMMIT}" \
                                    .
                            '''
                        }
                    }
                }
                stage('Build Cron') {
                    steps {
                        dir(BACKEND_DIR) {
                            sh '''
                                echo "🏗️ Building Cron image..."
                                CACHE_FLAG="--cache-from ${CRON_IMAGE}:latest"
                                if [ "${FORCE_REBUILD}" = "true" ]; then
                                    CACHE_FLAG="--no-cache"
                                fi
                                
                                docker build \
                                    -f docker/Dockerfile.cron \
                                    -t ${CRON_IMAGE}:${DOCKER_TAG} \
                                    -t ${CRON_IMAGE}:latest \
                                    $CACHE_FLAG \
                                    --build-arg BUILDKIT_INLINE_CACHE=1 \
                                    --label "build.number=${BUILD_NUMBER}" \
                                    --label "git.commit=${GIT_COMMIT}" \
                                    .
                            '''
                        }
                    }
                }
            }
        }

        // ============================================
        // Stage 4: Push Images to Registry
        // ============================================
        stage('Push Images') {
            steps {
                script {
                    // Tag current images as 'previous' for rollback
                    sh '''
                        docker tag ${API_IMAGE}:latest ${API_IMAGE}:previous || true
                        docker tag ${SOCKET_IMAGE}:latest ${SOCKET_IMAGE}:previous || true
                        docker tag ${MATCHMAKING_IMAGE}:latest ${MATCHMAKING_IMAGE}:previous || true
                        docker tag ${CRON_IMAGE}:latest ${CRON_IMAGE}:previous || true
                    '''
                }
                withCredentials([usernamePassword(
                    credentialsId: 'docker-hub-creds',
                    usernameVariable: 'DOCKER_USER',
                    passwordVariable: 'DOCKER_PASS'
                )]) {
                    sh '''
                        echo "🔐 Logging into Docker Hub..."
                        echo $DOCKER_PASS | docker login -u $DOCKER_USER --password-stdin
                        
                        echo "📤 Pushing images to registry..."
                        # Push all images with version tag and latest
                        docker push ${API_IMAGE}:${DOCKER_TAG}
                        docker push ${API_IMAGE}:latest
                        docker push ${API_IMAGE}:previous
                        
                        docker push ${SOCKET_IMAGE}:${DOCKER_TAG}
                        docker push ${SOCKET_IMAGE}:latest
                        docker push ${SOCKET_IMAGE}:previous
                        
                        docker push ${MATCHMAKING_IMAGE}:${DOCKER_TAG}
                        docker push ${MATCHMAKING_IMAGE}:latest
                        docker push ${MATCHMAKING_IMAGE}:previous
                        
                        docker push ${CRON_IMAGE}:${DOCKER_TAG}
                        docker push ${CRON_IMAGE}:latest
                        docker push ${CRON_IMAGE}:previous
                        
                        echo "✅ All images pushed successfully!"
                    '''
                }
            }
        }

        // ============================================
        // Stage 5: Deploy to Server (Simple Rolling Update)
        // ============================================
        stage('Deploy') {
            when {
                expression { return params.DEPLOY_AFTER_BUILD }
            }
            steps {
                sh '''
                    echo "🚀 Starting local deployment from Jenkins workspace..."

                    set -e
                    cd ${WORKSPACE}

                    echo "📦 Pulling latest images (TAG=latest)..."
                    export TAG=latest
                    docker-compose -f docker-compose.production.yml pull

                    echo "🔄 Updating services with minimal downtime..."
                    docker-compose -f docker-compose.production.yml up -d

                    echo "✅ Current container status:"
                    docker-compose -f docker-compose.production.yml ps
                '''
            }
        }
    }

    // ============================================
    // Post-Build Actions
    // ============================================
    post {
        success {
            echo "✅ Build #${env.BUILD_NUMBER} built and pushed Docker images successfully!"
            // Uncomment to enable Slack notifications
            // slackSend(
            //     color: 'good',
            //     message: "✅ Circle Backend deployed!\nBuild: #${env.BUILD_NUMBER}\nCommit: ${env.GIT_COMMIT_MSG}"
            // )
        }
        failure {
            echo "❌ Build #${env.BUILD_NUMBER} failed!"
            // Uncomment to enable Slack notifications
            // slackSend(
            //     color: 'danger',
            //     message: "❌ Circle Backend deployment failed!\nBuild: #${env.BUILD_NUMBER}\nCommit: ${env.GIT_COMMIT_MSG}"
            // )
        }
        always {
            // Clean up workspace
            cleanWs(cleanWhenNotBuilt: false,
                    deleteDirs: true,
                    disableDeferredWipeout: true,
                    notFailBuild: true)
        }
    }
}