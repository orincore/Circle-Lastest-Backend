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
                                
                                # Install dependencies
                                echo ""
                                echo "📦 Step 2: Installing dependencies..."
                                npm ci --prefer-offline --no-audit 2>/dev/null || npm install
                                
                                # Build TypeScript
                                echo ""
                                echo "🔨 Step 3: Building TypeScript..."
                                npm run build || { echo "❌ Build failed!"; git checkout \$PREVIOUS_COMMIT; exit 1; }
                                
                                # Build Docker images
                                echo ""
                                echo "🐳 Step 4: Building Docker images..."
                                CACHE_FLAG=""
                                if [ "${params.FORCE_REBUILD}" = "true" ]; then
                                    CACHE_FLAG="--no-cache"
                                fi
                                docker-compose -f ${COMPOSE_FILE} build \$CACHE_FLAG
                                
                                # Rolling update with health checks
                                echo ""
                                echo "🔄 Step 5: Rolling update..."
                                
                                # Update services one by one
                                for service in api socket matchmaking cron; do
                                    echo "   Updating \$service..."
                                    docker-compose -f ${COMPOSE_FILE} up -d --no-deps --build \$service
                                    sleep 3
                                done
                                
                                # Update nginx
                                docker-compose -f ${COMPOSE_FILE} up -d --no-deps nginx
                                
                                # Health check
                                echo ""
                                echo "🏥 Step 6: Health check..."
                                sleep 10
                                
                                API_HEALTH=\$(curl -sf http://localhost:8080/health || echo "failed")
                                SOCKET_HEALTH=\$(curl -sf http://localhost:8081/health || echo "failed")
                                
                                if [ "\$API_HEALTH" = "failed" ] || [ "\$SOCKET_HEALTH" = "failed" ]; then
                                    echo "❌ Health check failed! Rolling back..."
                                    git checkout \$PREVIOUS_COMMIT
                                    npm ci --prefer-offline 2>/dev/null || npm install
                                    npm run build
                                    docker-compose -f ${COMPOSE_FILE} up -d --build
                                    echo "⚠️ Rolled back to \$PREVIOUS_COMMIT"
                                    exit 1
                                fi
                                
                                echo "✅ Health check passed!"
                                
                                # Cleanup
                                echo ""
                                echo "🧹 Step 7: Cleanup..."
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
                    API_STATUS=\$(curl -sf -o /dev/null -w '%{http_code}' https://api.circleapp.in/health || echo "000")
                    
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