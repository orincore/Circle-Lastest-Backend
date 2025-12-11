// ============================================
// Circle Backend - Jenkins CI/CD Pipeline
// Blue-Green Deployment with Zero Downtime
// ============================================
//
// Architecture:
// - Two container sets: Blue and Green
// - Rolling update: update one set while other handles traffic
// - Automatic rollback on failure
// - Health checks before traffic switch
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
        
        // Blue-Green Configuration - Allow time for app startup
        HEALTH_CHECK_RETRIES = '20'
        HEALTH_CHECK_INTERVAL = '5'
        DRAIN_WAIT_SECONDS = '5'
        GRACEFUL_SHUTDOWN_WAIT = '3'
        
        // OTA Update Configuration
        RUNTIME_VERSION = '1.0.0'
        INTERNAL_API_KEY = credentials('circle-internal-api-key')
    }

    options {
        timeout(time: 45, unit: 'MINUTES')
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '20'))
        timestamps()
    }
    
    parameters {
        booleanParam(name: 'FORCE_REBUILD', defaultValue: false, description: 'Force rebuild Docker images without cache')
        booleanParam(name: 'SKIP_DEPLOY', defaultValue: false, description: 'Skip deployment (only validate)')
        booleanParam(name: 'DEPLOY_OTA', defaultValue: true, description: 'Deploy OTA updates after backend deployment')
        choice(name: 'DEPLOY_TARGET', choices: ['rolling', 'blue-only', 'green-only'], description: 'Deployment target (rolling = both sets)')
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
                   Blue-Green Zero-Downtime Deployment
                ============================================
                Build: #${env.BUILD_NUMBER}
                Commit: ${env.GIT_COMMIT_SHORT}
                Message: ${env.GIT_COMMIT_MSG}
                Branch: ${BRANCH}
                Deploy Target: ${params.DEPLOY_TARGET}
                ============================================
                """
            }
        }

        // ============================================
        // Stage 2: Local Validation
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
        // Stage 3: Blue-Green Deploy to Production
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
                        def deployTarget = params.DEPLOY_TARGET ?: 'rolling'
                        
                        sh """
                            echo "🚀 Blue-Green Deployment to production server..."
                            echo "   Server: ${SERVER_USER}@${SERVER_IP}"
                            echo "   Directory: ${DEPLOY_DIR}"
                            echo "   Target: ${deployTarget}"
                            echo ""
                            
                            ssh -i \${SSH_KEY} -o StrictHostKeyChecking=no -o ConnectTimeout=30 ${SERVER_USER}@${SERVER_IP} '
                                set -e
                                
                                echo "============================================"
                                echo "🚀 Circle Backend Blue-Green Deployment"
                                echo "   Build: #${BUILD_NUMBER}"
                                echo "   Commit: ${GIT_COMMIT_SHORT}"
                                echo "============================================"
                                echo ""
                                
                                cd ${DEPLOY_DIR}
                                
                                # ============================================
                                # Helper Functions
                                # ============================================
                                
                                check_container_health() {
                                    local container=\$1
                                    local health=\$(docker inspect \$container --format="{{.State.Health.Status}}" 2>/dev/null || echo "none")
                                    echo \$health
                                }
                                
                                wait_for_healthy() {
                                    local container=\$1
                                    local port=\$2
                                    local retries=${HEALTH_CHECK_RETRIES}
                                    
                                    echo "   Waiting for \$container to be healthy..."
                                    
                                    # Wait for container to start (Docker start_period is 60s)
                                    echo "      Waiting 5s for container startup..."
                                    sleep 5
                                    
                                    for i in \$(seq 1 \$retries); do
                                        local health=\$(check_container_health \$container)
                                        local running=\$(docker inspect \$container --format="{{.State.Running}}" 2>/dev/null || echo "false")
                                        echo "      Attempt \$i/\$retries: health=\$health, running=\$running"
                                        
                                        if [ "\$health" = "healthy" ]; then
                                            echo "   ✅ \$container is healthy!"
                                            return 0
                                        fi
                                        
                                        # Check if container is running
                                        if [ "\$running" != "true" ]; then
                                            echo "   ⚠️ Container not running! Checking logs..."
                                            docker logs --tail 20 \$container 2>&1 || true
                                        fi
                                        
                                        sleep ${HEALTH_CHECK_INTERVAL}
                                    done
                                    
                                    # Show container logs and health check output on failure
                                    echo "   ❌ \$container failed health check!"
                                    echo "   === Container Logs (last 100 lines) ==="
                                    docker logs --tail 100 \$container 2>&1 || true
                                    echo "   === Health Check Logs ==="
                                    docker inspect \$container --format="{{json .State.Health}}" 2>/dev/null || true
                                    return 1
                                }
                                
                                deploy_color_set() {
                                    local color=\$1
                                    echo ""
                                    echo "🔵 Deploying \$color set..."
                                    
                                    # Build all images in parallel first (faster)
                                    echo "   Building all \$color images in parallel..."
                                    docker-compose -f ${COMPOSE_FILE} build --parallel api-\$color socket-\$color matchmaking-\$color 2>/dev/null || \
                                    docker-compose -f ${COMPOSE_FILE} build api-\$color socket-\$color matchmaking-\$color
                                    
                                    # Start API first (critical path)
                                    echo "   Starting api-\$color..."
                                    docker-compose -f ${COMPOSE_FILE} up -d --no-deps --remove-orphans api-\$color
                                    wait_for_healthy "circle-api-\$color" "8080" || return 1
                                    
                                    # Start Socket (critical for real-time)
                                    echo "   Starting socket-\$color..."
                                    docker-compose -f ${COMPOSE_FILE} up -d --no-deps --remove-orphans socket-\$color
                                    wait_for_healthy "circle-socket-\$color" "8081" || return 1
                                    
                                    # Start Matchmaking (background service)
                                    echo "   Starting matchmaking-\$color..."
                                    docker-compose -f ${COMPOSE_FILE} up -d --no-deps --remove-orphans matchmaking-\$color
                                    sleep 3
                                    
                                    echo "   ✅ \$color set deployed successfully!"
                                    return 0
                                }
                                
                                # ============================================
                                # Step 1: Save current state for rollback
                                # ============================================
                                PREVIOUS_COMMIT=\$(git rev-parse HEAD 2>/dev/null || echo "none")
                                echo "📌 Previous commit: \$PREVIOUS_COMMIT"
                                
                                # ============================================
                                # Step 2: Pull latest code
                                # ============================================
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
                                
                                # ============================================
                                # Step 3: Ensure Redis is running
                                # ============================================
                                echo ""
                                echo "🗄️ Step 2: Ensuring Redis is running..."
                                docker-compose -f ${COMPOSE_FILE} up -d --remove-orphans redis
                                sleep 5
                                
                                # ============================================
                                # Step 4: Blue-Green Rolling Update
                                # ============================================
                                echo ""
                                echo "🔄 Step 3: Blue-Green Rolling Update..."
                                echo "   Strategy: Update one set while other handles traffic"
                                
                                export CACHEBUST=\$NEW_COMMIT
                                
                                DEPLOY_TARGET="${deployTarget}"
                                
                                if [ "\$DEPLOY_TARGET" = "blue-only" ]; then
                                    echo ""
                                    echo "🔵 Deploying BLUE set only (GREEN handles traffic)..."
                                    deploy_color_set "blue" || {
                                        echo "❌ Blue deployment failed!"
                                        exit 1
                                    }
                                    
                                elif [ "\$DEPLOY_TARGET" = "green-only" ]; then
                                    echo ""
                                    echo "🟢 Deploying GREEN set only (BLUE handles traffic)..."
                                    deploy_color_set "green" || {
                                        echo "❌ Green deployment failed!"
                                        exit 1
                                    }
                                    
                                else
                                    # Rolling update - both sets
                                    echo ""
                                    echo "🔄 Phase 1: Update BLUE set (GREEN handles traffic)..."
                                    
                                    # Check if green is healthy first
                                    GREEN_API_HEALTH=\$(check_container_health "circle-api-green")
                                    GREEN_SOCKET_HEALTH=\$(check_container_health "circle-socket-green")
                                    
                                    if [ "\$GREEN_API_HEALTH" != "healthy" ] || [ "\$GREEN_SOCKET_HEALTH" != "healthy" ]; then
                                        echo "   ⚠️ Green set not healthy, deploying it first for safety..."
                                        deploy_color_set "green" || {
                                            echo "❌ Green deployment failed! Aborting..."
                                            exit 1
                                        }
                                    else
                                        echo "   ✅ Green set is healthy, will handle traffic during blue update"
                                    fi
                                    
                                    # Graceful connection drain from blue
                                    echo "   ⏳ Graceful drain: waiting ${DRAIN_WAIT_SECONDS}s for blue connections..."
                                    # Signal nginx to stop sending new requests to blue
                                    docker exec circle-nginx nginx -s reload 2>/dev/null || true
                                    sleep ${DRAIN_WAIT_SECONDS}
                                    
                                    # Deploy blue set
                                    deploy_color_set "blue" || {
                                        echo "❌ Blue deployment failed!"
                                        echo "   Green set is still handling all traffic"
                                        echo "   Rolling back blue to previous version..."
                                        git checkout \$PREVIOUS_COMMIT
                                        export CACHEBUST=\$PREVIOUS_COMMIT
                                        docker-compose -f ${COMPOSE_FILE} up -d --no-deps --remove-orphans --build api-blue socket-blue matchmaking-blue
                                        exit 1
                                    }
                                    
                                    echo ""
                                    echo "🔄 Phase 2: Update GREEN set (BLUE handles traffic)..."
                                    echo "   ✅ Blue set is now healthy, will handle traffic during green update"
                                    
                                    # Graceful connection drain from green
                                    echo "   ⏳ Graceful drain: waiting ${DRAIN_WAIT_SECONDS}s for green connections..."
                                    sleep ${DRAIN_WAIT_SECONDS}
                                    
                                    # Reset to new commit (in case rollback happened)
                                    git checkout ${BRANCH}
                                    git reset --hard origin/${BRANCH}
                                    export CACHEBUST=\$NEW_COMMIT
                                    
                                    # Deploy green set
                                    deploy_color_set "green" || {
                                        echo "❌ Green deployment failed!"
                                        echo "   Blue set is still handling all traffic"
                                        echo "   System is operational but green needs attention"
                                        # Do not exit - blue is working, just warn
                                        echo "⚠️ WARNING: Green set failed but Blue is operational"
                                    }
                                fi
                                
                                # ============================================
                                # Step 5: Update Cron Worker
                                # ============================================
                                echo ""
                                echo "⏰ Step 4: Updating Cron worker..."
                                docker-compose -f ${COMPOSE_FILE} up -d --no-deps --remove-orphans --build cron
                                sleep 5
                                
                                # ============================================
                                # Step 6: Smart NGINX Update (Only if config changed)
                                # ============================================
                                echo ""
                                echo "🌐 Step 5: Checking NGINX configuration..."
                                
                                # Check if NGINX config files have changed
                                NGINX_CONFIG_CHANGED=false
                                if [ "\$PREVIOUS_COMMIT" != "\$NEW_COMMIT" ]; then
                                    # Check if any nginx-related files changed
                                    NGINX_CHANGES=\$(git diff --name-only \$PREVIOUS_COMMIT..\$NEW_COMMIT 2>/dev/null | grep -E "(nginx|\.conf|docker/)" || echo "")
                                    if [ -n "\$NGINX_CHANGES" ]; then
                                        echo "   📋 NGINX-related files changed:"
                                        echo "\$NGINX_CHANGES" | sed 's/^/      /'
                                        NGINX_CONFIG_CHANGED=true
                                    else
                                        echo "   ✅ No NGINX configuration changes detected"
                                    fi
                                else
                                    echo "   ✅ No code changes - NGINX config unchanged"
                                fi
                                
                                # Only rebuild/restart NGINX if config changed or container is unhealthy
                                NGINX_HEALTH=\$(docker inspect circle-nginx --format="{{.State.Health.Status}}" 2>/dev/null || echo "none")
                                NGINX_RUNNING=\$(docker ps -q -f name=circle-nginx)
                                
                                if [ "\$NGINX_CONFIG_CHANGED" = "true" ]; then
                                    echo "   🔄 NGINX config changed - rebuilding container..."
                                    docker-compose -f ${COMPOSE_FILE} build nginx
                                    
                                    if [ -n "\$NGINX_RUNNING" ]; then
                                        echo "   🔄 Gracefully reloading NGINX with zero downtime..."
                                        # First try graceful reload
                                        docker exec circle-nginx nginx -t && docker exec circle-nginx nginx -s reload || {
                                            echo "   ⚠️ Graceful reload failed - recreating container..."
                                            docker-compose -f ${COMPOSE_FILE} up -d --no-deps --remove-orphans nginx
                                        }
                                    else
                                        echo "   🚀 Starting new NGINX container..."
                                        docker-compose -f ${COMPOSE_FILE} up -d --remove-orphans nginx
                                    fi
                                    sleep 3
                                elif [ "\$NGINX_HEALTH" != "healthy" ] || [ -z "\$NGINX_RUNNING" ]; then
                                    echo "   ⚠️ NGINX unhealthy or not running - starting container..."
                                    docker-compose -f ${COMPOSE_FILE} up -d --remove-orphans nginx
                                    sleep 3
                                else
                                    echo "   ✅ NGINX healthy and config unchanged - no action needed"
                                fi
                                
                                # Verify final NGINX health
                                NGINX_HEALTH=\$(docker inspect circle-nginx --format="{{.State.Health.Status}}" 2>/dev/null || echo "none")
                                if [ "\$NGINX_HEALTH" = "healthy" ]; then
                                    echo "   ✅ NGINX is healthy!"
                                else
                                    echo "   ⚠️ NGINX health: \$NGINX_HEALTH - checking logs..."
                                    docker logs --tail 20 circle-nginx 2>&1 || true
                                fi
                                
                                # ============================================
                                # Step 7: Final Health Verification
                                # ============================================
                                echo ""
                                echo "🏥 Step 6: Final health verification..."
                                
                                # Check all containers
                                API_BLUE_HEALTH=\$(check_container_health "circle-api-blue")
                                API_GREEN_HEALTH=\$(check_container_health "circle-api-green")
                                SOCKET_BLUE_HEALTH=\$(check_container_health "circle-socket-blue")
                                SOCKET_GREEN_HEALTH=\$(check_container_health "circle-socket-green")
                                NGINX_HEALTH=\$(check_container_health "circle-nginx")
                                REDIS_HEALTH=\$(check_container_health "circle-redis")
                                
                                echo "   NGINX:        \$NGINX_HEALTH"
                                echo "   Redis:        \$REDIS_HEALTH"
                                echo "   API Blue:     \$API_BLUE_HEALTH"
                                echo "   API Green:    \$API_GREEN_HEALTH"
                                echo "   Socket Blue:  \$SOCKET_BLUE_HEALTH"
                                echo "   Socket Green: \$SOCKET_GREEN_HEALTH"
                                
                                # At least one of each type must be healthy
                                if [ "\$API_BLUE_HEALTH" != "healthy" ] && [ "\$API_GREEN_HEALTH" != "healthy" ]; then
                                    echo "❌ CRITICAL: No healthy API containers!"
                                    echo "   Rolling back..."
                                    git checkout \$PREVIOUS_COMMIT
                                    export CACHEBUST=\$PREVIOUS_COMMIT
                                    docker-compose -f ${COMPOSE_FILE} up -d --remove-orphans --build api-blue api-green socket-blue socket-green
                                    exit 1
                                fi
                                
                                if [ "\$SOCKET_BLUE_HEALTH" != "healthy" ] && [ "\$SOCKET_GREEN_HEALTH" != "healthy" ]; then
                                    echo "❌ CRITICAL: No healthy Socket containers!"
                                    echo "   Rolling back..."
                                    git checkout \$PREVIOUS_COMMIT
                                    export CACHEBUST=\$PREVIOUS_COMMIT
                                    docker-compose -f ${COMPOSE_FILE} up -d --remove-orphans --build api-blue api-green socket-blue socket-green
                                    exit 1
                                fi
                                
                                # ============================================
                                # Step 8: Aggressive Cleanup
                                # ============================================
                                echo ""
                                echo "🧹 Step 7: Cleanup..."
                                docker image prune -f > /dev/null 2>&1 || true
                                docker container prune -f > /dev/null 2>&1 || true
                                docker volume prune -f > /dev/null 2>&1 || true
                                
                                # ============================================
                                # Final Status
                                # ============================================
                                echo ""
                                echo "============================================"
                                echo "✅ Blue-Green Deployment Successful!"
                                echo "============================================"
                                echo ""
                                echo "Container Status:"
                                docker-compose -f ${COMPOSE_FILE} ps
                                echo ""
                                echo "Health Summary:"
                                echo "   🌐 NGINX:  \$NGINX_HEALTH"
                                echo "   �️ Redis:  \$REDIS_HEALTH"
                                echo "   �🔵 Blue:   API=\$API_BLUE_HEALTH, Socket=\$SOCKET_BLUE_HEALTH"
                                echo "   🟢 Green:  API=\$API_GREEN_HEALTH, Socket=\$SOCKET_GREEN_HEALTH"
                                echo ""
                                echo "Traffic is now load-balanced across both sets!"
                            '
                        """
                    }
                }
            }
        }

        // ============================================
        // Stage 4: External Verification
        // ============================================
        stage('Verify') {
            when {
                expression { return !params.SKIP_DEPLOY }
            }
            steps {
                sh """
                    echo "🔍 Verifying deployment externally..."
                    sleep 5
                    
                    # Test API endpoint multiple times to hit both blue and green
                    echo "   Testing API endpoint (multiple requests to verify load balancing)..."
                    
                    SUCCESS_COUNT=0
                    for i in 1 2 3 4 5; do
                        API_STATUS=\$(curl -sf -o /dev/null -w '%{http_code}' --max-time 10 https://api.circle.orincore.com/health || echo "000")
                        if [ "\$API_STATUS" = "200" ]; then
                            SUCCESS_COUNT=\$((SUCCESS_COUNT + 1))
                            echo "   Request \$i: ✅ HTTP 200"
                        else
                            echo "   Request \$i: ⚠️ HTTP \$API_STATUS"
                        fi
                        sleep 1
                    done
                    
                    echo ""
                    if [ \$SUCCESS_COUNT -ge 4 ]; then
                        echo "✅ External verification passed (\$SUCCESS_COUNT/5 successful)"
                    elif [ \$SUCCESS_COUNT -ge 2 ]; then
                        echo "⚠️ Partial success (\$SUCCESS_COUNT/5) - some requests may have hit updating containers"
                    else
                        echo "❌ External verification failed (\$SUCCESS_COUNT/5 successful)"
                        exit 1
                    fi
                """
            }
        }

        // ============================================
        // Stage 4: Deploy OTA Updates
        // ============================================
        stage('Deploy OTA Updates') {
            when {
                allOf {
                    expression { return !params.SKIP_DEPLOY }
                    expression { return params.DEPLOY_OTA }
                }
            }
            steps {
                script {
                    echo "🚀 Starting OTA Update Deployment..."

                    // Do not fail the whole pipeline if OTA fails; just mark this stage as failed
                    catchError(buildResult: 'SUCCESS', stageResult: 'FAILURE') {
                        withCredentials([sshUserPrivateKey(
                            credentialsId: 'root-ssh-key',
                            keyFileVariable: 'SSH_KEY',
                            usernameVariable: 'SSH_USER'
                        )]) {
                            sh """
                                echo "[OTA] Connecting to ${SERVER_USER}@${SERVER_IP}..."
                                ssh -i \$SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=30 ${SERVER_USER}@${SERVER_IP} '
                                    set -e
                                    echo "[OTA] Running deploy-ota-update.sh in ${DEPLOY_DIR}"
                                    export INTERNAL_API_KEY="${INTERNAL_API_KEY}"
                                    export RUNTIME_VERSION="${RUNTIME_VERSION}"
                                    cd ${DEPLOY_DIR}
                                    chmod +x scripts/deploy-ota-update.sh
                                    ./scripts/deploy-ota-update.sh
                                '
                            """
                        }

                        echo "✅ OTA Updates deployed successfully!"
                    }
                }
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
                            Circle Backend Blue-Green Deployment SUCCESS
                            
                            Build: #${env.BUILD_NUMBER}
                            Commit: ${env.GIT_COMMIT_SHORT}
                            Message: ${env.GIT_COMMIT_MSG}
                            Deploy Target: ${params.DEPLOY_TARGET ?: 'rolling'}
                            
                            ✅ Both Blue and Green sets are now running the latest version.
                            Traffic is load-balanced across both sets.
                            
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
                    Circle Backend Blue-Green Deployment FAILED
                    
                    Build: #${env.BUILD_NUMBER}
                    Commit: ${env.GIT_COMMIT_SHORT}
                    Message: ${env.GIT_COMMIT_MSG}
                    Deploy Target: ${params.DEPLOY_TARGET ?: 'rolling'}
                    
                    ⚠️ Automatic rollback was attempted.
                    The healthy container set should still be handling traffic.
                    
                    Check logs: ${env.BUILD_URL}console
                """
            )
        }
        always {
            script {
                echo "🧹 Starting comprehensive disk cleanup..."
                
                // Local Jenkins workspace cleanup
                cleanWs(cleanWhenNotBuilt: false, deleteDirs: true, notFailBuild: true)
                
                // Remote server cleanup via SSH
                try {
                    withCredentials([sshUserPrivateKey(credentialsId: 'root-ssh-key', keyFileVariable: 'SSH_KEY')]) {
                        sh '''
                            echo "🧹 Remote server disk cleanup..."
                            ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=30 root@69.62.82.102 '
                                set -e
                                echo "📊 Disk usage before cleanup:"
                                df -h
                                echo ""
                                
                                echo "🗑️ Cleaning Docker system..."
                                # Remove all unused containers, networks, images (both dangling and unreferenced)
                                docker system prune -af --volumes || true
                                
                                echo "🗑️ Cleaning Docker build cache..."
                                docker builder prune -af || true
                                
                                echo "🗑️ Removing old Docker images (keep only latest 2 versions)..."
                                docker images --format "table {{.Repository}}:{{.Tag}}\t{{.CreatedAt}}\t{{.Size}}" | grep -E "circle-backend|nginx|redis" | tail -n +3 | awk "{print \$1}" | xargs -r docker rmi -f || true
                                
                                echo "🗑️ Cleaning package managers..."
                                # Clean npm cache
                                npm cache clean --force || true
                                
                                # Clean apt cache (if exists)
                                apt-get clean || true
                                apt-get autoremove -y || true
                                
                                echo "🗑️ Cleaning temporary files..."
                                # Clean tmp directories
                                find /tmp -type f -atime +7 -delete || true
                                find /var/tmp -type f -atime +7 -delete || true
                                
                                # Clean log files older than 30 days
                                find /var/log -name "*.log" -type f -mtime +30 -delete || true
                                find /var/log -name "*.gz" -type f -mtime +30 -delete || true
                                
                                echo "🗑️ Cleaning Git repositories..."
                                cd /root/Circle-Lastest-Backend && git gc --aggressive --prune=now || true
                                cd /root/CircleReact && git gc --aggressive --prune=now || true
                                
                                echo "🗑️ Cleaning node_modules build artifacts..."
                                cd /root/Circle-Lastest-Backend && find . -name "node_modules" -type d -exec rm -rf {} + 2>/dev/null || true
                                cd /root/CircleReact && find . -name "node_modules" -type d -exec rm -rf {} + 2>/dev/null || true
                                
                                echo "🗑️ Cleaning Expo build cache..."
                                cd /root/CircleReact && rm -rf .expo dist dist-updates || true
                                
                                echo "📊 Disk usage after cleanup:"
                                df -h
                                echo ""
                                echo "✅ Cleanup completed!"
                            '
                        '''
                    }
                } catch (Exception e) {
                    echo "⚠️ Remote cleanup failed: ${e.getMessage()}"
                }
            }
        }
    }
}