#!/usr/bin/env node

/**
 * Backend Log Cleanup Script
 * Removes excessive console.log statements while preserving critical error logs
 */

const fs = require('fs');
const path = require('path');

// Patterns to remove (excessive/debug logs)
const REMOVE_PATTERNS = [
  // BlindDate processing logs
  /console\.log\('\[BlindDate\].*?\)/g,
  
  // Matchmaking heartbeat logs
  /logger\.info\(\s*\{[\s\S]*?\},\s*'Matchmaking heartbeat completed'\s*\)/g,
  
  // System metrics logs (keep only the conditional ones)
  /logger\.info\(\s*\{[\s\S]*?\},\s*'System metrics'\s*\)/g,
  
  // Commented debug logs
  /\/\/console\.log\(.*?\)/g,
  
  // Socket debug logs (keep errors)
  /console\.log\(`📊.*?\`\)/g,
  /console\.log\(`🔄.*?\`\)/g,
  /console\.log\(`📨.*?\`\)/g,
  /console\.log\(`❌.*?\`\)/g,
  /console\.log\(`✅.*?\`\)/g,
  /console\.log\(`👁️.*?\`\)/g,
  /console\.log\(`👤.*?\`\)/g,
  /console\.log\(`🚫.*?\`\)/g,
  /console\.log\(`📋.*?\`\)/g,
  /console\.log\(`🗑️.*?\`\)/g,
  /console\.log\(`ℹ️.*?\`\)/g,
  
  // Generic debug console.logs (but preserve console.error)
  /console\.log\('Processing match:'.*?\)/g,
  /console\.log\('Profile result:'.*?\)/g,
  /console\.log\('Found \d+ notifications'.*?\)/g,
  /console\.log\('User is authorized'.*?\)/g,
  /console\.log\('Chat.*cleared successfully'.*?\)/g,
];

// Patterns to keep (critical logs)
const KEEP_PATTERNS = [
  /console\.error/,
  /console\.warn/,
  /logger\.error/,
  /logger\.warn/,
  /logger\.fatal/,
];

function shouldKeepLog(line) {
  // Always keep error/warning logs
  for (const pattern of KEEP_PATTERNS) {
    if (pattern.test(line)) {
      return true;
    }
  }
  return false;
}

function cleanupFile(filePath) {
  try {
    let content = fs.readFileSync(filePath, 'utf8');
    let originalContent = content;
    let removedCount = 0;

    // Remove excessive log patterns
    for (const pattern of REMOVE_PATTERNS) {
      const matches = content.match(pattern);
      if (matches) {
        removedCount += matches.length;
        content = content.replace(pattern, '// Excessive log removed');
      }
    }

    // Clean up empty lines and multiple consecutive comment lines
    content = content
      .replace(/\/\/ Excessive log removed\n\s*\/\/ Excessive log removed/g, '// Multiple excessive logs removed')
      .replace(/\n\s*\n\s*\n/g, '\n\n'); // Remove triple+ newlines

    if (content !== originalContent) {
      fs.writeFileSync(filePath, content);
      console.log(`✅ Cleaned ${filePath} - removed ${removedCount} excessive logs`);
      return removedCount;
    }
    
    return 0;
  } catch (error) {
    console.error(`❌ Error cleaning ${filePath}:`, error.message);
    return 0;
  }
}

function findFilesToClean(dir, extensions = ['.ts', '.js']) {
  const files = [];
  
  function traverse(currentDir) {
    const items = fs.readdirSync(currentDir);
    
    for (const item of items) {
      const fullPath = path.join(currentDir, item);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        // Skip node_modules and other irrelevant directories
        if (!['node_modules', '.git', 'dist', 'build'].includes(item)) {
          traverse(fullPath);
        }
      } else if (stat.isFile()) {
        const ext = path.extname(item);
        if (extensions.includes(ext)) {
          files.push(fullPath);
        }
      }
    }
  }
  
  traverse(dir);
  return files;
}

function main() {
  console.log('🧹 Starting backend log cleanup...');
  
  const srcDir = path.join(__dirname, 'src');
  const files = findFilesToClean(srcDir);
  
  console.log(`📁 Found ${files.length} files to check`);
  
  let totalRemoved = 0;
  let filesModified = 0;
  
  for (const file of files) {
    const removed = cleanupFile(file);
    if (removed > 0) {
      totalRemoved += removed;
      filesModified++;
    }
  }
  
  console.log('\n🎉 Cleanup completed!');
  console.log(`📊 Summary:`);
  console.log(`   - Files checked: ${files.length}`);
  console.log(`   - Files modified: ${filesModified}`);
  console.log(`   - Total logs removed: ${totalRemoved}`);
  console.log('\n💡 Critical logs (errors, warnings) were preserved');
  console.log('💡 Run this script periodically to keep logs clean');
}

if (require.main === module) {
  main();
}

module.exports = { cleanupFile, findFilesToClean };
