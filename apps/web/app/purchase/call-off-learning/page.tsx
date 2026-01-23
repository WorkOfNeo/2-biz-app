'use client';

import React, { useState, useEffect } from 'react';
import useSWR from 'swr';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { Input } from '../../../components/ui/input';
import { Textarea } from '../../../components/ui/textarea';
import { Modal } from '../../../components/ui/modal';
import { 
  TrendingUp, 
  TrendingDown, 
  ThumbsUp, 
  ThumbsDown, 
  BarChart3, 
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Brain,
  Target,
  Settings,
  BookOpen,
  History,
  Search,
  Plus,
  Check,
  Edit2,
  Trash2,
  Save,
  Loader2,
  Filter
} from 'lucide-react';

// ==================== Types ====================
interface OverviewData {
  overview: {
    total: number;
    correct: number;
    incorrect: number;
    accuracy: number;
    days: number;
    stylesWithFeedback: number;
    avgCorrectionsPerStyle: number;
  };
  byFlow: Record<string, { total: number; correct: number; incorrect: number }>;
  byPromptVersion: Record<string, { total: number; correct: number; incorrect: number }>;
  dailyStats: Array<{ date: string; total: number; correct: number; incorrect: number }>;
  styleStats: Array<{
    style_no: string;
    total: number;
    correct: number;
    incorrect: number;
    accuracy: number;
    lastFeedback: string;
    adjustments: Record<string, number>;
  }>;
  activePrompts: Array<{ key: string; version: number; updated_at: string }>;
  recentEvents: Array<{
    id: string;
    event_type: string;
    prompt_key: string | null;
    prompt_version: number | null;
    details: Record<string, any>;
    created_at: string;
  }>;
  exampleCounts: Record<string, number>;
}

interface Prompt {
  id: string;
  key: string;
  version: number;
  content: string;
  active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface Example {
  id: string;
  prompt_key: string;
  title: string;
  tags: string[];
  context_snapshot: Record<string, any> | null;
  expected_behavior: string;
  enabled: boolean;
  created_at: string;
}

interface FeedbackEntry {
  id: string;
  style_no: string;
  color: string;
  verdict: 'correct' | 'incorrect';
  notes: string | null;
  suggested_order: Record<string, number> | null;
  actual_order: Record<string, number> | null;
  flow: string | null;
  prompt_key: string | null;
  prompt_version: number | null;
  reason_codes: string[] | null;
  created_at: string;
}

// ==================== Fetcher ====================
const fetcher = (url: string) => fetch(url).then(res => res.json());

// ==================== Tab Components ====================

// --- Overview Tab ---
function OverviewTab({ data, loading }: { data: OverviewData | null; loading: boolean }) {
  if (loading || !data) {
    return <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-slate-400" /></div>;
  }

  const { overview, dailyStats, activePrompts, byFlow, byPromptVersion } = data;

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-500">Total Feedback</p>
                <p className="text-2xl font-bold">{overview.total}</p>
              </div>
              <BarChart3 className="h-8 w-8 text-slate-300" />
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-500">Accuracy</p>
                <p className={`text-2xl font-bold ${
                  overview.accuracy >= 80 ? 'text-green-600' :
                  overview.accuracy >= 60 ? 'text-amber-600' :
                  'text-red-600'
                }`}>
                  {overview.accuracy.toFixed(1)}%
                </p>
              </div>
              {overview.accuracy >= 70 ? (
                <TrendingUp className="h-8 w-8 text-green-400" />
              ) : (
                <TrendingDown className="h-8 w-8 text-red-400" />
              )}
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-500">Correct</p>
                <p className="text-2xl font-bold text-green-600">{overview.correct}</p>
              </div>
              <ThumbsUp className="h-8 w-8 text-green-300" />
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-500">Corrections</p>
                <p className="text-2xl font-bold text-red-600">{overview.incorrect}</p>
              </div>
              <ThumbsDown className="h-8 w-8 text-red-300" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Learning Curve Chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Target className="h-4 w-4" />
            Learning Curve (Last {overview.days} Days)
          </CardTitle>
          <CardDescription>Green = correct, Red = corrections</CardDescription>
        </CardHeader>
        <CardContent>
          <MiniChart data={dailyStats} height={100} />
        </CardContent>
      </Card>

      {/* Active Prompts + By Flow */}
      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Active Prompts</CardTitle>
          </CardHeader>
          <CardContent>
            {activePrompts.length === 0 ? (
              <div className="text-sm text-slate-400">No active DB prompts (using code defaults)</div>
            ) : (
              <div className="space-y-2">
                {activePrompts.map(p => (
                  <div key={p.key} className="flex items-center justify-between text-sm">
                    <span className="font-mono">{p.key}</span>
                    <Badge className="bg-green-100 text-green-700">v{p.version}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Accuracy by Flow</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {Object.entries(byFlow).map(([flow, stats]) => (
                <div key={flow} className="flex items-center justify-between text-sm">
                  <span className="capitalize">{flow.replace('_', ' ')}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-500">{stats.total} total</span>
                    <Badge className={stats.total > 0 && (stats.correct / stats.total) >= 0.7 ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}>
                      {stats.total > 0 ? ((stats.correct / stats.total) * 100).toFixed(0) : 0}%
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Accuracy by Prompt Version */}
      {Object.keys(byPromptVersion).length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Accuracy by Prompt Version</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {Object.entries(byPromptVersion).map(([version, stats]) => (
                <div key={version} className="border rounded p-2 text-center">
                  <div className="font-mono text-xs text-slate-500 truncate">{version}</div>
                  <div className="text-lg font-bold">
                    {stats.total > 0 ? ((stats.correct / stats.total) * 100).toFixed(0) : 0}%
                  </div>
                  <div className="text-xs text-slate-400">{stats.total} samples</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// --- Feedback Explorer Tab ---
function FeedbackExplorerTab() {
  const [filter, setFilter] = useState({ flow: '', style: '', verdict: '' });
  const { data, error, isLoading, mutate } = useSWR<{ data: FeedbackEntry[] }>(
    '/api/call-off/feedback?limit=200',
    fetcher
  );

  const filtered = (data?.data || []).filter(f => {
    if (filter.flow && f.flow !== filter.flow) return false;
    if (filter.style && !f.style_no.toLowerCase().includes(filter.style.toLowerCase())) return false;
    if (filter.verdict && f.verdict !== filter.verdict) return false;
    return true;
  });

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        <select 
          value={filter.flow} 
          onChange={e => setFilter(f => ({ ...f, flow: e.target.value }))}
          className="border rounded px-3 py-1.5 text-sm"
        >
          <option value="">All Flows</option>
          <option value="quick_po">Quick PO</option>
          <option value="call_off">Call-Off</option>
        </select>
        <select 
          value={filter.verdict} 
          onChange={e => setFilter(f => ({ ...f, verdict: e.target.value }))}
          className="border rounded px-3 py-1.5 text-sm"
        >
          <option value="">All Verdicts</option>
          <option value="correct">Correct</option>
          <option value="incorrect">Incorrect</option>
        </select>
        <Input 
          placeholder="Filter by style..."
          value={filter.style}
          onChange={e => setFilter(f => ({ ...f, style: e.target.value }))}
          className="w-48"
        />
        <Button variant="outline" size="sm" onClick={() => mutate()}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {isLoading && <div className="text-center py-8"><Loader2 className="h-6 w-6 animate-spin mx-auto" /></div>}
      
      {!isLoading && filtered.length === 0 && (
        <div className="text-center py-8 text-slate-400">No feedback found</div>
      )}

      <div className="space-y-2 max-h-[600px] overflow-y-auto">
        {filtered.slice(0, 100).map(f => (
          <Card key={f.id} className="p-3">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  {f.verdict === 'correct' ? (
                    <ThumbsUp className="h-4 w-4 text-green-500" />
                  ) : (
                    <ThumbsDown className="h-4 w-4 text-red-500" />
                  )}
                  <span className="font-mono font-medium">{f.style_no}</span>
                  <span className="text-slate-500">{f.color}</span>
                </div>
                {f.notes && <p className="text-sm text-slate-500 mt-1">{f.notes}</p>}
                {f.prompt_key && (
                  <p className="text-xs text-slate-400 mt-1">
                    Prompt: {f.prompt_key} v{f.prompt_version || '?'}
                  </p>
                )}
              </div>
              <div className="text-right text-xs text-slate-400">
                <div>{new Date(f.created_at).toLocaleDateString()}</div>
                <Badge className="mt-1 text-[10px]">{f.flow || 'quick_po'}</Badge>
              </div>
            </div>
            {f.verdict === 'incorrect' && f.suggested_order && f.actual_order && (
              <div className="mt-2 pt-2 border-t grid grid-cols-2 gap-4 text-xs">
                <div>
                  <div className="font-medium text-slate-600 mb-1">Suggested</div>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(f.suggested_order).map(([size, qty]) => (
                      <span key={size} className="bg-slate-100 px-1.5 py-0.5 rounded">{size}: {qty}</span>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="font-medium text-slate-600 mb-1">Actual</div>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(f.actual_order).map(([size, qty]) => (
                      <span key={size} className="bg-green-100 px-1.5 py-0.5 rounded">{size}: {qty}</span>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

// --- Learned Adjustments Tab ---
function LearnedAdjustmentsTab({ data }: { data: OverviewData | null }) {
  const [expandedStyle, setExpandedStyle] = useState<string | null>(null);
  
  if (!data) return null;
  
  const { styleStats } = data;

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        Per-style size multipliers learned from corrections. Values {'>'} 1.0 mean order more, {'<'} 1.0 mean order less.
      </p>
      
      {styleStats.length === 0 ? (
        <div className="text-center py-8 text-slate-400">No feedback recorded yet</div>
      ) : (
        <div className="space-y-2">
          {styleStats.map(style => (
            <div key={style.style_no} className="border rounded-lg overflow-hidden">
              <button
                onClick={() => setExpandedStyle(expandedStyle === style.style_no ? null : style.style_no)}
                className="w-full px-4 py-3 flex items-center justify-between hover:bg-slate-50"
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono font-medium">{style.style_no}</span>
                  <Badge className="bg-green-100 text-green-700 text-xs">{style.correct} OK</Badge>
                  <Badge className="bg-red-100 text-red-700 text-xs">{style.incorrect} wrong</Badge>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-sm font-medium ${style.accuracy >= 80 ? 'text-green-600' : style.accuracy >= 60 ? 'text-amber-600' : 'text-red-600'}`}>
                    {style.accuracy.toFixed(0)}%
                  </span>
                  {expandedStyle === style.style_no ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </div>
              </button>
              
              {expandedStyle === style.style_no && (
                <div className="px-4 py-3 bg-slate-50 border-t">
                  {Object.keys(style.adjustments).length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(style.adjustments)
                        .sort(([a], [b]) => parseInt(a) - parseInt(b))
                        .map(([size, mult]) => (
                          <span 
                            key={size}
                            className={`px-2 py-1 rounded text-xs font-mono ${
                              mult > 1.1 ? 'bg-green-100 text-green-700' :
                              mult < 0.9 ? 'bg-red-100 text-red-700' :
                              'bg-slate-100 text-slate-600'
                            }`}
                          >
                            {size}: {mult.toFixed(2)}x
                          </span>
                        ))
                      }
                    </div>
                  ) : (
                    <div className="text-xs text-slate-400">No adjustments learned yet</div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Prompt Studio Tab ---
function PromptStudioTab() {
  const [selectedKey, setSelectedKey] = useState<string>('quick_po_flow_v1');
  const [editContent, setEditContent] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [activating, setActivating] = useState(false);
  
  const { data, mutate, isLoading } = useSWR<{ prompts: Prompt[]; byKey: Record<string, Prompt[]> }>(
    '/api/ai/prompts',
    fetcher
  );

  const promptKeys = ['quick_po_flow_v1', 'call_off_analysis_v2'];
  const versions = data?.byKey?.[selectedKey] || [];
  const activeVersion = versions.find(v => v.active);

  useEffect(() => {
    if (activeVersion) {
      setEditContent(activeVersion.content);
    }
  }, [activeVersion?.id]);

  const handleSave = async (activate: boolean) => {
    setSaving(true);
    try {
      await fetch('/api/ai/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: selectedKey,
          content: editContent,
          notes: editNotes,
          setActive: activate
        })
      });
      setEditNotes('');
      mutate();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const handleActivate = async (version: number) => {
    setActivating(true);
    try {
      await fetch('/api/ai/prompts/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: selectedKey, version })
      });
      mutate();
    } catch (e) {
      console.error(e);
    } finally {
      setActivating(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <select 
          value={selectedKey} 
          onChange={e => setSelectedKey(e.target.value)}
          className="border rounded px-3 py-2 font-mono text-sm"
        >
          {promptKeys.map(k => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
        {activeVersion && (
          <Badge className="bg-green-100 text-green-700">Active: v{activeVersion.version}</Badge>
        )}
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* Editor */}
        <div className="lg:col-span-2 space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Edit Prompt</CardTitle>
              <CardDescription>Changes create a new version. Activate to make it live.</CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea 
                value={editContent}
                onChange={e => setEditContent(e.target.value)}
                rows={20}
                className="font-mono text-xs"
                placeholder="Prompt content..."
              />
              <div className="mt-3 flex items-center gap-2">
                <Input 
                  value={editNotes}
                  onChange={e => setEditNotes(e.target.value)}
                  placeholder="Version notes (optional)..."
                  className="flex-1"
                />
                <Button onClick={() => handleSave(false)} disabled={saving} variant="outline">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
                  Save Draft
                </Button>
                <Button onClick={() => handleSave(true)} disabled={saving} className="bg-green-600 hover:bg-green-700">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4 mr-1" />}
                  Save + Activate
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Version History */}
        <div>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Version History</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
              {versions.length === 0 && !isLoading && (
                <div className="text-sm text-slate-400">No versions in DB (using code defaults)</div>
              )}
              <div className="space-y-2 max-h-[400px] overflow-y-auto">
                {versions.map(v => (
                  <div key={v.id} className={`border rounded p-2 ${v.active ? 'border-green-500 bg-green-50' : ''}`}>
                    <div className="flex items-center justify-between">
                      <span className="font-medium">v{v.version}</span>
                      {v.active ? (
                        <Badge className="bg-green-600 text-white">Active</Badge>
                      ) : (
                        <Button 
                          size="sm" 
                          variant="outline" 
                          onClick={() => handleActivate(v.version)}
                          disabled={activating}
                        >
                          Activate
                        </Button>
                      )}
                    </div>
                    {v.notes && <p className="text-xs text-slate-500 mt-1">{v.notes}</p>}
                    <p className="text-xs text-slate-400 mt-1">
                      {new Date(v.created_at).toLocaleDateString()}
                    </p>
                    <button 
                      onClick={() => setEditContent(v.content)}
                      className="text-xs text-indigo-600 hover:underline mt-1"
                    >
                      Load into editor
                    </button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

// --- Examples Library Tab ---
function ExamplesLibraryTab() {
  const [selectedKey, setSelectedKey] = useState('quick_po_flow_v1');
  const [showAddModal, setShowAddModal] = useState(false);
  const [newExample, setNewExample] = useState({ title: '', expected_behavior: '', tags: '' });
  const [saving, setSaving] = useState(false);

  const { data, mutate, isLoading } = useSWR<{ examples: Example[] }>(
    `/api/ai/examples?prompt_key=${selectedKey}`,
    fetcher
  );

  const handleAdd = async () => {
    setSaving(true);
    try {
      await fetch('/api/ai/examples', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt_key: selectedKey,
          title: newExample.title,
          expected_behavior: newExample.expected_behavior,
          tags: newExample.tags.split(',').map(t => t.trim()).filter(Boolean),
          enabled: true
        })
      });
      setNewExample({ title: '', expected_behavior: '', tags: '' });
      setShowAddModal(false);
      mutate();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (example: Example) => {
    await fetch('/api/ai/examples', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: example.id, enabled: !example.enabled })
    });
    mutate();
  };

  const deleteExample = async (id: string) => {
    if (!confirm('Delete this example?')) return;
    await fetch('/api/ai/examples', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    mutate();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <select 
            value={selectedKey} 
            onChange={e => setSelectedKey(e.target.value)}
            className="border rounded px-3 py-2 font-mono text-sm"
          >
            <option value="quick_po_flow_v1">quick_po_flow_v1</option>
            <option value="call_off_analysis_v2">call_off_analysis_v2</option>
          </select>
          <span className="text-sm text-slate-500">
            {data?.examples?.length || 0} examples
          </span>
        </div>
        <Button onClick={() => setShowAddModal(true)}>
          <Plus className="h-4 w-4 mr-1" /> Add Example
        </Button>
      </div>

      <p className="text-sm text-slate-500">
        Examples are included in the AI prompt to guide behavior. Tag by style/supplier/scenario for targeted retrieval.
      </p>

      {isLoading && <div className="text-center py-8"><Loader2 className="h-6 w-6 animate-spin mx-auto" /></div>}

      <div className="space-y-3">
        {(data?.examples || []).map(ex => (
          <Card key={ex.id} className={!ex.enabled ? 'opacity-50' : ''}>
            <CardContent className="pt-4">
              <div className="flex items-start justify-between">
                <div>
                  <h4 className="font-medium">{ex.title}</h4>
                  {ex.tags.length > 0 && (
                    <div className="flex gap-1 mt-1">
                      {ex.tags.map(t => (
                        <Badge key={t} className="text-xs border-slate-300">{t}</Badge>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex gap-1">
                  <Button 
                    size="sm" 
                    variant="ghost" 
                    onClick={() => toggleEnabled(ex)}
                    title={ex.enabled ? 'Disable' : 'Enable'}
                  >
                    {ex.enabled ? <Check className="h-4 w-4 text-green-600" /> : <Check className="h-4 w-4 text-slate-300" />}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => deleteExample(ex.id)}>
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </div>
              </div>
              <p className="text-sm text-slate-600 mt-2 whitespace-pre-wrap">{ex.expected_behavior}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Add Modal */}
      <Modal isOpen={showAddModal} onClose={() => setShowAddModal(false)} title="Add Example">
        <div className="p-4 space-y-4">
          <div>
            <label className="text-sm font-medium">Title</label>
            <Input 
              value={newExample.title}
              onChange={e => setNewExample(n => ({ ...n, title: e.target.value }))}
              placeholder="e.g., 'RANY WHITE overstocked scenario'"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Tags (comma-separated)</label>
            <Input 
              value={newExample.tags}
              onChange={e => setNewExample(n => ({ ...n, tags: e.target.value }))}
              placeholder="e.g., style:1010191, scenario:overstocked"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Expected Behavior</label>
            <Textarea 
              value={newExample.expected_behavior}
              onChange={e => setNewExample(n => ({ ...n, expected_behavior: e.target.value }))}
              rows={6}
              placeholder="Describe what the AI should do in this scenario..."
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowAddModal(false)}>Cancel</Button>
            <Button onClick={handleAdd} disabled={saving || !newExample.title || !newExample.expected_behavior}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Plus className="h-4 w-4 mr-1" />}
              Add Example
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// --- Change Log Tab ---
function ChangeLogTab({ data }: { data: OverviewData | null }) {
  if (!data) return null;
  
  const { recentEvents } = data;

  const eventTypeLabels: Record<string, string> = {
    prompt_activated: 'Prompt Activated',
    prompt_created: 'Prompt Created',
    example_added: 'Example Added',
    example_updated: 'Example Updated',
    example_disabled: 'Example Disabled',
    multipliers_updated: 'Multipliers Updated',
    manual_override: 'Manual Override'
  };

  const eventTypeColors: Record<string, string> = {
    prompt_activated: 'bg-green-100 text-green-700',
    prompt_created: 'bg-blue-100 text-blue-700',
    example_added: 'bg-purple-100 text-purple-700',
    example_updated: 'bg-amber-100 text-amber-700',
    example_disabled: 'bg-red-100 text-red-700',
    multipliers_updated: 'bg-indigo-100 text-indigo-700',
    manual_override: 'bg-slate-100 text-slate-700'
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        Audit trail of all learning system changes
      </p>
      
      {recentEvents.length === 0 ? (
        <div className="text-center py-8 text-slate-400">No events recorded yet</div>
      ) : (
        <div className="space-y-2">
          {recentEvents.map(ev => (
            <Card key={ev.id} className="p-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <Badge className={eventTypeColors[ev.event_type] || 'bg-slate-100'}>
                    {eventTypeLabels[ev.event_type] || ev.event_type}
                  </Badge>
                  {ev.prompt_key && (
                    <span className="font-mono text-sm text-slate-600">
                      {ev.prompt_key} {ev.prompt_version && `v${ev.prompt_version}`}
                    </span>
                  )}
                </div>
                <span className="text-xs text-slate-400">
                  {new Date(ev.created_at).toLocaleString()}
                </span>
              </div>
              {ev.details && Object.keys(ev.details).length > 0 && (
                <pre className="text-xs text-slate-500 mt-2 bg-slate-50 p-2 rounded overflow-x-auto">
                  {JSON.stringify(ev.details, null, 2)}
                </pre>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ==================== Helper Components ====================

function MiniChart({ data, height = 60 }: { data: Array<{ date: string; total: number; correct: number; incorrect: number }>; height?: number }) {
  if (data.length === 0) return <div className="text-slate-400 text-sm">No data yet</div>;
  
  const maxTotal = Math.max(...data.map(d => d.total), 1);
  
  return (
    <div className="flex items-end gap-0.5" style={{ height }}>
      {data.map((day) => {
        const correctHeight = (day.correct / maxTotal) * height;
        const incorrectHeight = (day.incorrect / maxTotal) * height;
        
        return (
          <div 
            key={day.date} 
            className="flex-1 flex flex-col justify-end"
            title={`${day.date}: ${day.correct} correct, ${day.incorrect} incorrect`}
          >
            <div className="bg-red-400 w-full rounded-t-sm" style={{ height: incorrectHeight }} />
            <div className="bg-green-500 w-full" style={{ height: correctHeight }} />
          </div>
        );
      })}
    </div>
  );
}

// ==================== Main Page ====================

export default function LearningStudioPage() {
  const [activeTab, setActiveTab] = useState('overview');
  
  const { data, isLoading, mutate } = useSWR<OverviewData>(
    '/api/learning/overview?days=30',
    fetcher,
    { refreshInterval: 60000 }
  );

  const tabs = [
    { id: 'overview', label: 'Overview', icon: BarChart3 },
    { id: 'feedback', label: 'Feedback Explorer', icon: Search },
    { id: 'adjustments', label: 'Learned Adjustments', icon: TrendingUp },
    { id: 'prompts', label: 'Prompt Studio', icon: Settings },
    { id: 'examples', label: 'Examples Library', icon: BookOpen },
    { id: 'changelog', label: 'Change Log', icon: History },
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <Brain className="h-6 w-6 text-indigo-600" />
            Learning Studio
          </h1>
          <p className="text-slate-500 mt-1">
            Track AI learning, manage prompts, and add examples for Quick PO + NOOS Call-Off
          </p>
        </div>
        <Button onClick={() => mutate()} variant="outline" disabled={isLoading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Tabs */}
      <div className="border-b">
        <div className="flex gap-1 overflow-x-auto">
          {tabs.map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  activeTab === tab.id
                    ? 'border-indigo-600 text-indigo-600'
                    : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
                }`}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab Content */}
      <div>
        {activeTab === 'overview' && <OverviewTab data={data || null} loading={isLoading} />}
        {activeTab === 'feedback' && <FeedbackExplorerTab />}
        {activeTab === 'adjustments' && <LearnedAdjustmentsTab data={data || null} />}
        {activeTab === 'prompts' && <PromptStudioTab />}
        {activeTab === 'examples' && <ExamplesLibraryTab />}
        {activeTab === 'changelog' && <ChangeLogTab data={data || null} />}
      </div>
    </div>
  );
}
