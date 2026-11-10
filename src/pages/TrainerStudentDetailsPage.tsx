import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Loader } from '../components/ui/Loader';
import { toast } from '../utils/toast';
import {
  getMyStudentForTrainer,
  openStudentDashboardAsStaff,
  type TrainerStudentRow,
} from '../lib/formEngine';

/**
 * Trainer view of one student: basic details and, when the batch allows it, "Login as student".
 * No admin actions (edit, delete, payment plans) live here. The server refuses students outside
 * the trainer's batches, and re-checks again when the button is pressed.
 */
export const TrainerStudentDetailsPage: React.FC = () => {
  const { studentId } = useParams();
  const sid = Number(studentId);
  const { user } = useAuth();
  const [student, setStudent] = useState<TrainerStudentRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [notAllowed, setNotAllowed] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStudent(null);
    setNotAllowed(null);
    if (!Number.isFinite(sid) || sid <= 0) {
      setNotAllowed('You can only view students in the batches you train.');
      setLoading(false);
      return;
    }
    setLoading(true);
    void getMyStudentForTrainer(sid).then((res) => {
      if (cancelled) return;
      if (res.ok) setStudent(res.student);
      else setNotAllowed(res.message);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [sid]);

  const loginAsStudent = async () => {
    if (!student || !student.can_login_as_student || opening) return;
    setOpening(true);
    const res = await openStudentDashboardAsStaff(student.id, student.email, user?.id);
    setOpening(false);
    if (!res.ok) {
      toast.error(res.message);
      if (res.reason === 'forbidden') setStudent((s) => (s ? { ...s, can_login_as_student: false } : s));
    }
  };

  const row = (label: string, value: string | null | undefined) => (
    <div className="flex flex-col sm:flex-row sm:items-baseline gap-0.5 sm:gap-3 py-2 border-b border-gray-100 last:border-b-0">
      <dt className="w-32 shrink-0 text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="text-sm text-gray-800 break-words min-w-0">{value?.trim() ? value : '—'}</dd>
    </div>
  );

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <div className="w-full max-w-3xl px-4 md:px-6 lg:px-8 py-6">
        <Link
          to="/admin/my-students"
          className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 hover:underline mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          My students
        </Link>

        {loading ? (
          <Card>
            <div className="py-12">
              <Loader variant="dots" size="lg" message="Loading student..." />
            </div>
          </Card>
        ) : !student ? (
          <Card>
            <h2 className="text-lg font-bold text-[var(--text)]">Not allowed</h2>
            <p className="text-sm text-gray-600 mt-2">
              {notAllowed ?? 'You can only view students in the batches you train.'}
            </p>
          </Card>
        ) : (
          <Card>
            <h2 className="text-lg font-bold text-[var(--text)] break-words">{student.full_name || student.email}</h2>
            <dl className="mt-3">
              {row('Student ID', student.student_code)}
              {row('Email', student.email)}
              {row('Phone', student.phone)}
              {row('Status', student.status)}
              {row('Batch', student.batch_name)}
              {row('Course', student.course_name)}
            </dl>
            <div className="mt-4 border-t border-gray-100 pt-4">
              {student.can_login_as_student ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full sm:w-auto border-[var(--brand)]/30 text-[var(--brand)] hover:bg-[var(--brand)]/10"
                    onClick={() => void loginAsStudent()}
                    disabled={opening}
                  >
                    {opening ? 'Opening…' : 'Login as student'}
                  </Button>
                  <p className="mt-2 text-xs text-gray-500">
                    Opens this student's dashboard in a new tab so you can help with submissions. Every login is recorded.
                  </p>
                </>
              ) : (
                <p className="text-xs text-gray-500">
                  Logging in as this student is not switched on for this batch. An admin can allow it in Edit Batch.
                </p>
              )}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
};
