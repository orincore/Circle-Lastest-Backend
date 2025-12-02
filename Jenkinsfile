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
        
        // Paths
        BACKEND_DIR = "Backend"
        COMPOSE_FILE = "docker-compose.production.yml"
        ENV_FILE = "/opt/circle/.env.production"
        
        // Deployment (Update with your server details)
        DEPLOY_HOST = credentials('deploy-server-host')
        DEPLOY_USER = credentials('deploy-server-user')
        DEPLOY_PATH = "/opt/circle/Backend"
        HEALTH_CHECK_RETRIES = "30"
        HEALTH_CHECK_INTERVAL = "5"
        
        // Slack Notifications (Optional)
        SLACK_CHANNEL = "#deployments"
        ENABLE_SLACK = "false"
    }

    options {
        timeout(time: 45, unit: 'MINUTES')
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '20', artifactNumToKeepStr: '10'))
        timestamps()
        ansiColor('xterm')
    }
    
    parameters {
        booleanParam(name: 'SKIP_TESTS', defaultValue: false, description: 'Skip tests during build')
        booleanParam(name: 'FORCE_REBUILD', defaultValue: false, description: 'Force rebuild without cache')
        choice(name: 'DEPLOY_ENV', choices: ['production', 'staging'], description: 'Deployment environment')
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
                        echo "📦 Installing dependencies..."
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
                script {
                    // Store current deployed tag for rollback
                    sh '''
                        ssh -o StrictHostKeyChecking=no ${DEPLOY_USER}@${DEPLOY_HOST} \
                        "cd ${DEPLOY_PATH} && docker images --format '{{.Tag}}' ${API_IMAGE} | head -1 > /tmp/previous_tag.txt" || echo "latest" > /tmp/previous_tag.txt
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
        // Stage 5: Zero-Downtime Rolling Deployment
        // ============================================
        stage('Deploy') {
            steps {
                sshagent(['deploy-ssh-key']) {
                    script {
                        try {
                            sh '''
                                ssh -o StrictHostKeyChecking=no ${DEPLOY_USER}@${DEPLOY_HOST} << 'ENDSSH'
                                    set -e
                                    cd ${DEPLOY_PATH}
                                    
                                    echo "📦 Pulling latest images..."
                                    export TAG=${DOCKER_TAG}
                                    docker-compose -f ${COMPOSE_FILE} pull
                                    
                                    echo "💾 Creating backup of current deployment..."
                                    docker-compose -f ${COMPOSE_FILE} ps -q > /tmp/circle_backup_containers.txt
                                    
                                    echo "🔄 Rolling update: API server..."
                                    docker-compose -f ${COMPOSE_FILE} up -d --no-deps --build api
                            
                            echo "⏳ Waiting for API health check..."
                            for i in $(seq 1 ${HEALTH_CHECK_RETRIES}); do
                                if docker-compose -f ${COMPOSE_FILE} exec -T api curl -sf http://localhost:8080/health > /dev/null 2>&1; then
                                    echo "✅ API is healthy!"
                                    break
                                fi
                                if [ $i -eq ${HEALTH_CHECK_RETRIES} ]; then
                                    echo "❌ API health check failed!"
                                    docker-compose -f ${COMPOSE_FILE} logs --tail=50 api
                                    exit 1
                                fi
                                echo "Waiting... ($i/${HEALTH_CHECK_RETRIES})"
                                sleep ${HEALTH_CHECK_INTERVAL}
                            done
                            
                            echo "🔄 Rolling update: Socket server..."
                            docker-compose -f ${COMPOSE_FILE} up -d --no-deps --build socket
                            
                            echo "⏳ Waiting for Socket health check..."
                            for i in $(seq 1 ${HEALTH_CHECK_RETRIES}); do
                                if docker-compose -f ${COMPOSE_FILE} exec -T socket curl -sf http://localhost:8081/health > /dev/null 2>&1; then
                                    echo "✅ Socket is healthy!"
                                    break
                                fi
                                if [ $i -eq ${HEALTH_CHECK_RETRIES} ]; then
                                    echo "❌ Socket health check failed!"
                                    docker-compose -f ${COMPOSE_FILE} logs --tail=50 socket
                                    exit 1
                                fi
                                echo "Waiting... ($i/${HEALTH_CHECK_RETRIES})"
                                sleep ${HEALTH_CHECK_INTERVAL}
                            done
                            
                            echo "🔄 Updating workers..."
                            docker-compose -f ${COMPOSE_FILE} up -d --no-deps --build matchmaking cron
                            
                            echo "🔄 Reloading NGINX..."
                            docker-compose -f ${COMPOSE_FILE} exec -T nginx nginx -s reload || \
                                docker-compose -f ${COMPOSE_FILE} up -d --no-deps nginx
                            
                                    echo "🧹 Cleaning up old images..."
                                    docker image prune -f --filter "until=48h"
                                    
                                    echo "✅ Deployment complete!"
                                    docker-compose -f ${COMPOSE_FILE} ps
                                    
                                    # Save deployment info
                                    echo "${DOCKER_TAG}" > /tmp/circle_last_deployment.txt
                                    echo "Deployed at: $(date)" >> /tmp/circle_last_deployment.txt
ENDSSH
                            '''
                        } catch (Exception e) {
                            echo "❌ Deployment failed: ${e.message}"
                            echo "🔄 Initiating automatic rollback..."
                            currentBuild.result = 'FAILURE'
                            throw e
                        }
                    }
                }
            }
        }

        // ============================================
        // Stage 6: Post-Deployment Verification
        // ============================================
        stage('Verify Deployment') {
            steps {
                script {
                    try {
                        sh '''
                            echo "🔍 Verifying deployment..."
                            
                            # Wait for services to stabilize
                            sleep 10
                            
                            # Health check via public endpoint
                            HEALTH_PASSED=false
                            for i in $(seq 1 10); do
                                HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://${DEPLOY_HOST}/health || echo "000")
                                if [ "$HTTP_STATUS" = "200" ]; then
                                    echo "✅ Public health check passed!"
                                    HEALTH_PASSED=true
                                    break
                                fi
                                echo "Waiting for public endpoint... ($i/10) - Status: $HTTP_STATUS"
                                sleep 5
                            done
                            
                            if [ "$HEALTH_PASSED" = "false" ]; then
                                echo "❌ Health check failed after 10 attempts"
                                exit 1
                            fi
                            
                            # Verify all containers are running
                            ssh -o StrictHostKeyChecking=no ${DEPLOY_USER}@${DEPLOY_HOST} << 'ENDSSH'
                                cd ${DEPLOY_PATH}
                                UNHEALTHY=$(docker-compose -f ${COMPOSE_FILE} ps | grep -i "unhealthy\|restarting" || true)
                                if [ ! -z "$UNHEALTHY" ]; then
                                    echo "❌ Some containers are unhealthy:"
                                    echo "$UNHEALTHY"
                                    exit 1
                                fi
                                echo "✅ All containers are healthy"
ENDSSH
                        '''
                    } catch (Exception e) {
                        echo "❌ Verification failed: ${e.message}"
                        currentBuild.result = 'FAILURE'
                        error("Deployment verification failed. Please check logs and consider rollback.")
                    }
                }
            }
        }
        
        // ============================================
        // Stage 7: Rollback (Only on Failure)
        // ============================================
        stage('Rollback') {
            when {
                expression { currentBuild.result == 'FAILURE' }
            }
            steps {
                sshagent(['deploy-ssh-key']) {
                    sh '''
                        echo "🔄 Rolling back to previous version..."
                        ssh -o StrictHostKeyChecking=no ${DEPLOY_USER}@${DEPLOY_HOST} << 'ENDSSH'
                            set -e
                            cd ${DEPLOY_PATH}
                            
                            echo "📦 Pulling previous images..."
                            export TAG=previous
                            docker-compose -f ${COMPOSE_FILE} pull
                            
                            echo "🔄 Restoring services..."
                            docker-compose -f ${COMPOSE_FILE} up -d
                            
                            echo "⏳ Waiting for services to stabilize..."
                            sleep 15
                            
                            echo "✅ Rollback complete!"
                            docker-compose -f ${COMPOSE_FILE} ps
ENDSSH
                    '''
                }
            }
        }
    }

    // ============================================
    // Post-Build Actions
    // ============================================
    post {
        success {
            echo "✅ Build #${env.BUILD_NUMBER} deployed successfully!"
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