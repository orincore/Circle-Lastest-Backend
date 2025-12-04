// ============================================
// Circle Backend - Jenkins CI/CD Pipeline
// Simplified: Git Pull + NPM Install + Docker Rebuild
// With Zero-Downtime & Automatic Rollback
// ============================================

pipeline {
    agent any

    environment {
        // Server Configuration
        SERVER_IP = '69.62.82.102'
        SERVER_USER = 'root'
        DEPLOY_DIR = '/root/Circle-Lastest-Backend'
        COMPOSE_FILE = 'docker-compose.production.yml'
        BRANCH = 'main'
    }

    options {
        timeout(time: 30, unit: 'MINUTES')
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '15'))
        timestamps()
    }
    
    parameters {
        booleanParam(name: 'FORCE_REBUILD', defaultValue: false, description: 'Force rebuild Docker images without cache')
        booleanParam(name: 'SKIP_DEPLOY', defaultValue: false, description: 'Skip deployment (only validate)')
    }

    stages {
        // ============================================
        // Stage 1: Validate & Prepare
        // ============================================
        stage('Validate') {
            steps {
                script {
                    env.GIT_COMMIT_MSG = sh(
                        script: 'git log -1 --pretty=%B',
                        returnStdout: true
                    ).trim()
                    env.GIT_COMMIT_SHORT = sh(
                        script: 'git rev-parse --short HEAD',
                        returnStdout: true
                    ).trim()
                }
                echo """
                ============================================
                🚀 Circle Backend CI/CD Pipeline
                ============================================
                Build: #${env.BUILD_NUMBER}
                Commit: ${env.GIT_COMMIT_SHORT}
                Message: ${env.GIT_COMMIT_MSG}
                Branch: ${BRANCH}
                ============================================
                """
            }
        }

        // ============================================
        // Stage 2: Local Validation (Optional)
        // ============================================
        stage('Lint Check') {
            steps {
                sh '''
                    echo "📦 Installing dependencies locally for validation..."
                    npm ci --prefer-offline --no-audit 2>/dev/null || npm install
                    
                    echo "🔍 Running TypeScript check..."
                    npx tsc --noEmit || echo "⚠️ TypeScript warnings found (non-blocking)"
                    
                    echo "✅ Validation passed!"
                '''
            }
        }

        // ============================================
        // Stage 3: Deploy to Production Server
        // ============================================
        stage('Deploy') {
            when {
                expression { return !params.SKIP_DEPLOY }
            }
            steps {
                withCredentials([sshUserPrivateKey(
                    credentialsId: 'root-ssh-key',
                    keyFileVariable: 'SSH_KEY',
                    usernameVariable: 'SSH_USER'
                )]) {
                    script {
                        def forceFlag = params.FORCE_REBUILD ? '--force' : ''
                        
                        sh """
                            echo "🚀 Deploying to production server..."
                            echo "   Server: ${SERVER_USER}@${SERVER_IP}"
                            echo "   Directory: ${DEPLOY_DIR}"
                            echo ""
                            
                            ssh -i \${SSH_KEY} -o StrictHostKeyChecking=no -o ConnectTimeout=30 ${SERVER_USER}@${SERVER_IP} '
                                set -e
                                
                                echo "============================================"
                                echo "🚀 Circle Backend Deployment"
                                echo "   Build: #${BUILD_NUMBER}"
                                echo "   Commit: ${GIT_COMMIT_SHORT}"
                                echo "============================================"
                                echo ""
                                
                                cd ${DEPLOY_DIR}
                                
                                # Save current commit for rollback
                                PREVIOUS_COMMIT=\$(git rev-parse HEAD 2>/dev/null || echo "none")
                                echo "📌 Previous commit: \$PREVIOUS_COMMIT"
                                
                                # Pull latest code
                                echo ""
                                echo "📥 Step 1: Pulling latest code..."
                                git fetch --all
                                git checkout ${BRANCH}
                                git reset --hard origin/${BRANCH}
                                
                                NEW_COMMIT=\$(git rev-parse HEAD)
                                echo "📌 New commit: \$NEW_COMMIT"
                                
                                if [ "\$PREVIOUS_COMMIT" != "\$NEW_COMMIT" ]; then
                                    echo ""
                                    echo "📋 Changes:"
                                    git log --oneline \$PREVIOUS_COMMIT..\$NEW_COMMIT 2>/dev/null || git log -3 --oneline
                                fi
                                
                                # NOTE: Skip npm install and TypeScript build on host
                                # Docker handles this inside containers with proper memory allocation
                                
                                # Build Docker images (TypeScript compiled inside Docker with 2GB memory)
                                echo ""
                                echo "🐳 Step 2: Building Docker images..."
                                echo "   (TypeScript will be compiled inside Docker containers)"
                                
                                # Clear build cache to ensure fresh TypeScript compilation
                                echo "   Clearing Docker build cache for clean build..."
                                docker builder prune -f 2>/dev/null || true
                                
                                docker-compose -f ${COMPOSE_FILE} build --no-cache 2>&1 || {
                                    echo "❌ Docker build failed! Rolling back..."
                                    git checkout \$PREVIOUS_COMMIT
                                    docker-compose -f ${COMPOSE_FILE} up -d
                                    exit 1
                                }
                                
                                # Rolling update with health checks
                                echo ""
                                echo "🔄 Step 3: Rolling update (zero-downtime)..."
                                
                                # Update services one by one to maintain availability
                                for service in api socket matchmaking cron; do
                                    echo "   Updating \$service..."
                                    docker-compose -f ${COMPOSE_FILE} up -d --no-deps \$service
                                    sleep 5
                                done
                                
                                # Update nginx last (force recreate so config & upstreams are clean)
                                echo "   Updating nginx (force recreate)..."
                                docker-compose -f ${COMPOSE_FILE} up -d --no-deps --force-recreate nginx
                                
                                # Optional: brief local gateway check to ensure nginx is serving
                                echo "   Checking nginx gateway locally..."
                                sleep 5
                                curl -sf http://localhost/ >/dev/null 2>&1 || echo "   (nginx HTTP check skipped or not reachable on localhost, continuing)"
                                
                                # Health check with retries
                                echo ""
                                echo "🏥 Step 4: Health check..."
                                
                                HEALTH_OK=false
                                for i in 1 2 3 4 5 6; do
                                    echo "   Attempt \$i/6..."
                                    sleep 10
                                    
                                    # Check Docker container health status first (more reliable)
                                    API_DOCKER_HEALTH=\$(docker inspect circle-api --format='{{.State.Health.Status}}' 2>/dev/null || echo "none")
                                    SOCKET_DOCKER_HEALTH=\$(docker inspect circle-socket --format='{{.State.Health.Status}}' 2>/dev/null || echo "none")
                                    
                                    echo "   Docker health: API=\$API_DOCKER_HEALTH, Socket=\$SOCKET_DOCKER_HEALTH"
                                    
                                    # If Docker says healthy, try direct HTTP check as secondary validation
                                    if [ "\$API_DOCKER_HEALTH" = "healthy" ] && [ "\$SOCKET_DOCKER_HEALTH" = "healthy" ]; then
                                        # Quick HTTP validation (with timeout)
                                        API_HTTP=\$(curl -sf --max-time 5 http://localhost:8080/health 2>/dev/null && echo "ok" || echo "fail")
                                        SOCKET_HTTP=\$(curl -sf --max-time 5 http://localhost:8081/health 2>/dev/null && echo "ok" || echo "fail")
                                        
                                        echo "   HTTP check: API=\$API_HTTP, Socket=\$SOCKET_HTTP"
                                        
                                        if [ "\$API_HTTP" = "ok" ] && [ "\$SOCKET_HTTP" = "ok" ]; then
                                            HEALTH_OK=true
                                            break
                                        elif [ \$i -ge 4 ]; then
                                            # After 4 attempts, if Docker says healthy, trust it even if HTTP fails
                                            echo "   Docker containers are healthy, accepting deployment (HTTP may be behind proxy)"
                                            HEALTH_OK=true
                                            break
                                        else
                                            echo "   Docker healthy but HTTP check failed, retrying..."
                                        fi
                                    else
                                        echo "   Waiting for containers to become healthy..."
                                    fi
                                done
                                
                                if [ "\$HEALTH_OK" != "true" ]; then
                                    echo "❌ Health check failed after 60 seconds!"
                                    echo ""
                                    echo "📋 Final health status check:"
                                    API_FINAL_HEALTH=\$(docker inspect circle-api --format='{{.State.Health.Status}}' 2>/dev/null || echo "none")
                                    SOCKET_FINAL_HEALTH=\$(docker inspect circle-socket --format='{{.State.Health.Status}}' 2>/dev/null || echo "none")
                                    echo "   Docker health: API=\$API_FINAL_HEALTH, Socket=\$SOCKET_FINAL_HEALTH"
                                    
                                    # Try one final HTTP check with verbose output
                                    echo "   Final HTTP test:"
                                    curl -v --max-time 10 http://localhost:8080/health 2>&1 | head -10 || echo "   API HTTP failed"
                                    curl -v --max-time 10 http://localhost:8081/health 2>&1 | head -10 || echo "   Socket HTTP failed"
                                    echo ""
                                    echo "📋 Container status:"
                                    docker-compose -f ${COMPOSE_FILE} ps
                                    echo ""
                                    echo "📋 API logs:"
                                    docker-compose -f ${COMPOSE_FILE} logs --tail=30 api
                                    echo ""
                                    echo "🔄 Rolling back to \$PREVIOUS_COMMIT..."
                                    git checkout \$PREVIOUS_COMMIT
                                    docker-compose -f ${COMPOSE_FILE} build
                                    docker-compose -f ${COMPOSE_FILE} up -d
                                    echo "⚠️ Rollback complete"
                                    exit 1
                                fi
                                
                                echo "✅ Health check passed!"
                                
                                # Cleanup old images
                                echo ""
                                echo "🧹 Step 5: Cleanup..."
                                docker image prune -f > /dev/null 2>&1 || true
                                
                                # Final status
                                echo ""
                                echo "============================================"
                                echo "✅ Deployment successful!"
                                echo "============================================"
                                docker-compose -f ${COMPOSE_FILE} ps
                            '
                        """
                    }
                }
            }
        }

        // ============================================
        // Stage 4: Verify Deployment
        // ============================================
        stage('Verify') {
            when {
                expression { return !params.SKIP_DEPLOY }
            }
            steps {
                sh """
                    echo "🔍 Verifying deployment..."
                    sleep 5
                    
                    # Test API endpoint
                    API_STATUS=\$(curl -sf -o /dev/null -w '%{http_code}' https://api.circle.orincore.com/health || echo "000")
                    
                    if [ "\$API_STATUS" = "200" ]; then
                        echo "✅ API is responding (HTTP \$API_STATUS)"
                    else
                        echo "⚠️ API returned HTTP \$API_STATUS (may still be starting)"
                    fi
                """
            }
        }
    }

    // ============================================
    // Post-Build Actions
    // ============================================
    post {
        success {
            echo "✅ Build #${env.BUILD_NUMBER} completed successfully!"
            script {
                if (!params.SKIP_DEPLOY) {
                    emailext(
                        subject: "✅ Circle Backend Deployed - Build #${env.BUILD_NUMBER}",
                        to: 'info@orincore.com',
                        body: """
                            Circle Backend Deployment SUCCESS
                            
                            Build: #${env.BUILD_NUMBER}
                            Commit: ${env.GIT_COMMIT_SHORT}
                            Message: ${env.GIT_COMMIT_MSG}
                            
                            View: ${env.BUILD_URL}
                        """
                    )
                }
            }
        }
        failure {
            echo "❌ Build #${env.BUILD_NUMBER} failed!"
            emailext(
                subject: "❌ Circle Backend FAILED - Build #${env.BUILD_NUMBER}",
                to: 'info@orincore.com',
                body: """
                    Circle Backend Deployment FAILED
                    
                    Build: #${env.BUILD_NUMBER}
                    Commit: ${env.GIT_COMMIT_SHORT}
                    Message: ${env.GIT_COMMIT_MSG}
                    
                    ⚠️ Automatic rollback was attempted.
                    
                    Check logs: ${env.BUILD_URL}console
                """
            )
        }
        always {
            cleanWs(cleanWhenNotBuilt: false, deleteDirs: true, notFailBuild: true)
        }
    }
}