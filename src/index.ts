// Main worker entrypoint — orchestrates all scheduled jobs
// Individual jobs are registered here as the system grows

async function main(): Promise<void> {
  console.log('LimaLeads worker started');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
