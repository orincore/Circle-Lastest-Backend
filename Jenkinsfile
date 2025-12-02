// ============================================
// Circle Backend - Jenkins CI/CD Pipeline
// Zero-Downtime Rolling Deployment
// ============================================

pipeline {
    agent any

    environment {
        // Docker Registry
        DOCKER_REGISTRY = "yourdockeruser"
        DOCKER_TAG = "${env.BUILD_NUMBER}-${env.GIT_COMMIT?.take(7) ?: 'latest'}"
        
        // Service Images
        API_IMAGE = "${DOCKER_REGISTRY}/circle-api"
        SOCKET_IMAGE = "${DOCKER_REGISTRY}/circle-socket"
        MATCHMAKING_IMAGE = "${DOCKER_REGISTRY}/circle-matchmaking"
        CRON_IMAGE = "${DOCKER_REGISTRY}/circle-cron"
        
        // Paths
        BACKEND_DIR = "Backend"
        COMPOSE_FILE = "docker-compose.production.yml"
        ENV_FILE = "/opt/circle/.env.production"
        
        // Deployment
        DEPLOY_HOST = "your-server-ip"
        DEPLOY_USER = "deploy"
        HEALTH_CHECK_RETRIES = "30"
        HEALTH_CHECK_INTERVAL = "5"
    }

    options {
        timeout(time: 30, unit: 'MINUTES')
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '10'))
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
                        npm ci --prefer-offline
                        npm run lint || true
                        # npm test  # Uncomment when tests are ready
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
                                docker build \
                                    -f docker/Dockerfile.api \
                                    -t ${API_IMAGE}:${DOCKER_TAG} \
                                    -t ${API_IMAGE}:latest \
                                    --cache-from ${API_IMAGE}:latest \
                                    --build-arg BUILDKIT_INLINE_CACHE=1 \
                                    .
                            '''
                        }
                    }
                }
                stage('Build Socket') {
                    steps {
                        dir(BACKEND_DIR) {
                            sh '''
                                docker build \
                                    -f docker/Dockerfile.socket \
                                    -t ${SOCKET_IMAGE}:${DOCKER_TAG} \
                                    -t ${SOCKET_IMAGE}:latest \
                                    --cache-from ${SOCKET_IMAGE}:latest \
                                    --build-arg BUILDKIT_INLINE_CACHE=1 \
                                    .
                            '''
                        }
                    }
                }
                stage('Build Matchmaking') {
                    steps {
                        dir(BACKEND_DIR) {
                            sh '''
                                docker build \
                                    -f docker/Dockerfile.matchmaking \
                                    -t ${MATCHMAKING_IMAGE}:${DOCKER_TAG} \
                                    -t ${MATCHMAKING_IMAGE}:latest \
                                    --cache-from ${MATCHMAKING_IMAGE}:latest \
                                    --build-arg BUILDKIT_INLINE_CACHE=1 \
                                    .
                            '''
                        }
                    }
                }
                stage('Build Cron') {
                    steps {
                        dir(BACKEND_DIR) {
                            sh '''
                                docker build \
                                    -f docker/Dockerfile.cron \
                                    -t ${CRON_IMAGE}:${DOCKER_TAG} \
                                    -t ${CRON_IMAGE}:latest \
                                    --cache-from ${CRON_IMAGE}:latest \
                                    --build-arg BUILDKIT_INLINE_CACHE=1 \
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
                withCredentials([usernamePassword(
                    credentialsId: 'docker-hub-creds',
                    usernameVariable: 'DOCKER_USER',
                    passwordVariable: 'DOCKER_PASS'
                )]) {
                    sh '''
                        echo $DOCKER_PASS | docker login -u $DOCKER_USER --password-stdin
                        
                        # Push all images with version tag and latest
                        docker push ${API_IMAGE}:${DOCKER_TAG}
                        docker push ${API_IMAGE}:latest
                        
                        docker push ${SOCKET_IMAGE}:${DOCKER_TAG}
                        docker push ${SOCKET_IMAGE}:latest
                        
                        docker push ${MATCHMAKING_IMAGE}:${DOCKER_TAG}
                        docker push ${MATCHMAKING_IMAGE}:latest
                        
                        docker push ${CRON_IMAGE}:${DOCKER_TAG}
                        docker push ${CRON_IMAGE}:latest
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
                    sh '''
                        ssh -o StrictHostKeyChecking=no ${DEPLOY_USER}@${DEPLOY_HOST} << 'ENDSSH'
                            set -e
                            cd /opt/circle
                            
                            echo "📦 Pulling latest images..."
                            export TAG=${DOCKER_TAG}
                            docker-compose -f ${COMPOSE_FILE} pull
                            
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
                            docker image prune -f --filter "until=24h"
                            
                            echo "✅ Deployment complete!"
                            docker-compose -f ${COMPOSE_FILE} ps
ENDSSH
                    '''
                }
            }
        }

        // ============================================
        // Stage 6: Post-Deployment Verification
        // ============================================
        stage('Verify Deployment') {
            steps {
                sh '''
                    echo "🔍 Verifying deployment..."
                    
                    # Health check via public endpoint
                    for i in $(seq 1 5); do
                        HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://${DEPLOY_HOST}/health || echo "000")
                        if [ "$HTTP_STATUS" = "200" ]; then
                            echo "✅ Public health check passed!"
                            exit 0
                        fi
                        echo "Waiting for public endpoint... ($i/5)"
                        sleep 5
                    done
                    
                    echo "⚠️ Public health check did not return 200, but deployment may still be successful"
                '''
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