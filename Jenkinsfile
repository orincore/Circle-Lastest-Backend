pipeline {
    agent any

    environment {
        DOCKER_IMAGE = "yourdockeruser/circle-backend"
        DOCKER_TAG   = "latest"
        BACKEND_DIR  = "Backend"
        CONTAINER_NAME = "circle-backend"
        ENV_FILE = "/opt/circle-backend.env"
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Install & Test') {
            steps {
                dir(BACKEND_DIR) {
                    sh 'npm install'
                    // TODO: add tests later, e.g. sh "npm test"
                }
            }
        }

        stage('Build Docker image') {
            steps {
                dir(BACKEND_DIR) {
                    sh 'docker build -t $DOCKER_IMAGE:$DOCKER_TAG .'
                }
            }
        }

        stage('Push Image') {
            steps {
                withCredentials([usernamePassword(
                    credentialsId: 'docker-hub-creds',
                    usernameVariable: 'DOCKER_USER',
                    passwordVariable: 'DOCKER_PASS'
                )]) {
                    sh 'echo $DOCKER_PASS | docker login -u $DOCKER_USER --password-stdin'
                    sh 'docker push $DOCKER_IMAGE:$DOCKER_TAG'
                }
            }
        }

        stage('Deploy') {
            steps {
                sh '''
                    docker pull $DOCKER_IMAGE:$DOCKER_TAG
                    docker stop $CONTAINER_NAME || true
                    docker rm $CONTAINER_NAME || true
                    docker run -d --name $CONTAINER_NAME \
                      --restart always \
                      --env-file $ENV_FILE \
                      -p 8080:8080 \
                      $DOCKER_IMAGE:$DOCKER_TAG
                '''
            }
        }
    }
}