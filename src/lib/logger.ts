import { getSupabaseClient } from '../db/client';

export type JobStatus = 'started' | 'success' | 'error';

export async function logJob(
  jobType: string,
  status: JobStatus,
  details: Record<string, unknown> = {},
): Promise<void> {
  try {
    const { error } = await getSupabaseClient().from('job_log').insert({
      job_type: jobType,
      status,
      details,
    });

    if (error) {
      console.error('Failed to write job log:', error);
    }
  } catch (error) {
    console.error('Failed to write job log:', error);
  }
}
