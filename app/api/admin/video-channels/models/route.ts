import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { createVideoModel, getVideoChannel, getVideoModels } from '@/lib/db';
import type { VideoDuration, VideoModelFeatures } from '@/types';

export const dynamic = 'force-dynamic';

type RemoteModel = {
  id: string;
  owned_by?: string;
};

type VideoCategory = 't2v' | 'i2v' | 'r2v' | 'upsample';

type ClassifiedVideoModel = {
  apiModel: string;
  name: string;
  description: string;
  category: VideoCategory;
  features: VideoModelFeatures;
  aspectRatios: Array<{ value: string; label: string }>;
  defaultAspectRatio: string;
  durations: VideoDuration[];
  defaultDuration: string;
};

const CATEGORY_ORDER: Record<VideoCategory, number> = {
  t2v: 1,
  i2v: 2,
  r2v: 3,
  upsample: 4,
};

function inferDurationSeconds(modelId: string): 10 | 15 | 25 {
  const lower = modelId.toLowerCase();
  if (/_d_25_|(?:^|_)25s?(?:_|$)/.test(lower)) return 25;
  if (/_d_15_|(?:^|_)15s?(?:_|$)/.test(lower)) return 15;
  return 10;
}

function inferDurationCost(modelId: string, category: VideoCategory, seconds: 10 | 15 | 25): number {
  const lower = modelId.toLowerCase();
  if (category === 'upsample') {
    if (/_4k$/.test(lower)) return 200;
    if (/_1080p$/.test(lower)) return 150;
    return 150;
  }
  if (seconds === 25) return 200;
  if (seconds === 15) return 150;
  return 100;
}

function inferAspectRatio(modelId: string): { value: string; label: string } {
  const lower = modelId.toLowerCase();
  if (lower.includes('portrait')) {
    return { value: 'portrait', label: '9:16' };
  }
  if (lower.includes('square')) {
    return { value: 'square', label: '1:1' };
  }
  return { value: 'landscape', label: '16:9' };
}

function classifyFlow2ApiModel(modelId: string): ClassifiedVideoModel | null {
  const lower = modelId.toLowerCase();
  if (!lower.startsWith('veo_')) return null;

  const isUpsample = /_(4k|1080p)$/.test(lower);
  const isT2V = lower.includes('_t2v_');
  const isI2V = lower.includes('_i2v_');
  const isR2V = lower.includes('_r2v_');

  if (!isT2V && !isI2V && !isR2V) return null;

  let category: VideoCategory;
  if (isUpsample) category = 'upsample';
  else if (isI2V) category = 'i2v';
  else if (isR2V) category = 'r2v';
  else category = 't2v';

  const seconds = inferDurationSeconds(modelId);
  const cost = inferDurationCost(modelId, category, seconds);
  const duration = `${seconds}s`;
  const aspectRatio = inferAspectRatio(modelId);

  const descriptionByCategory: Record<VideoCategory, string> = {
    t2v: 'Flow2API text-to-video model',
    i2v: 'Flow2API image-to-video model (1-2 images)',
    r2v: 'Flow2API reference-images-to-video model (multiple images)',
    upsample: 'Flow2API video upsample model',
  };

  const features: VideoModelFeatures = {
    textToVideo: true,
    imageToVideo: isI2V || isR2V,
    videoToVideo: false,
    supportStyles: false,
  };

  return {
    apiModel: modelId,
    name: modelId,
    description: descriptionByCategory[category],
    category,
    features,
    aspectRatios: [aspectRatio],
    defaultAspectRatio: aspectRatio.value,
    durations: [{ value: duration, label: `${seconds} 秒`, cost }],
    defaultDuration: duration,
  };
}

function sortClassifiedModels(models: ClassifiedVideoModel[]): ClassifiedVideoModel[] {
  return [...models].sort((left, right) => {
    const categoryOrder = CATEGORY_ORDER[left.category] - CATEGORY_ORDER[right.category];
    if (categoryOrder !== 0) return categoryOrder;
    return left.apiModel.localeCompare(right.apiModel);
  });
}

async function fetchChannelRemoteModels(channelId: string): Promise<RemoteModel[]> {
  const channel = await getVideoChannel(channelId);
  if (!channel) {
    throw new Error('渠道不存在');
  }
  if (channel.type !== 'flow2api') {
    throw new Error('仅支持 Flow2API 渠道一键导入');
  }
  if (!channel.baseUrl) {
    throw new Error('该渠道未配置 Base URL');
  }

  const baseUrl = channel.baseUrl.replace(/\/$/, '');
  const modelsUrl = `${baseUrl}/v1/models`;
  const apiKey = channel.apiKey?.split(',')[0]?.trim();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(modelsUrl, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(`拉取 /v1/models 失败 (${response.status})${details ? `: ${details}` : ''}`);
  }

  const data = await response.json();
  const models = (data?.data || data?.models || []) as RemoteModel[];
  return Array.isArray(models) ? models : [];
}

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user || session.user.role !== 'admin') {
      return NextResponse.json({ error: '无权限' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const channelId = searchParams.get('channelId');
    if (!channelId) {
      return NextResponse.json({ error: '缺少 channelId' }, { status: 400 });
    }

    const remoteModels = await fetchChannelRemoteModels(channelId);
    const classified = sortClassifiedModels(
      remoteModels
        .map((model) => classifyFlow2ApiModel(model.id))
        .filter((model): model is ClassifiedVideoModel => Boolean(model))
    );

    return NextResponse.json({
      success: true,
      data: {
        total: remoteModels.length,
        matched: classified.length,
        models: classified.map((model) => ({
          id: model.apiModel,
          name: model.name,
          category: model.category,
          defaultAspectRatio: model.defaultAspectRatio,
          defaultDuration: model.defaultDuration,
        })),
      },
    });
  } catch (error) {
    console.error('[API] Fetch flow2api video models error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '拉取模型失败' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user || session.user.role !== 'admin') {
      return NextResponse.json({ error: '无权限' }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const channelId = typeof body?.channelId === 'string' ? body.channelId : '';
    if (!channelId) {
      return NextResponse.json({ error: '缺少 channelId' }, { status: 400 });
    }

    const remoteModels = await fetchChannelRemoteModels(channelId);
    const classified = sortClassifiedModels(
      remoteModels
        .map((model) => classifyFlow2ApiModel(model.id))
        .filter((model): model is ClassifiedVideoModel => Boolean(model))
    );

    if (classified.length === 0) {
      return NextResponse.json(
        { error: '远程 /v1/models 未发现可导入的视频模型' },
        { status: 400 }
      );
    }

    const existing = await getVideoModels();
    const existingApiModels = new Set(
      existing
        .filter((model) => model.channelId === channelId)
        .map((model) => model.apiModel)
    );
    const existingCount = existing.filter((model) => model.channelId === channelId).length;

    let created = 0;
    let skipped = 0;
    const failed: string[] = [];

    for (const model of classified) {
      if (existingApiModels.has(model.apiModel)) {
        skipped += 1;
        continue;
      }
      try {
        await createVideoModel({
          channelId,
          name: model.name,
          description: model.description,
          apiModel: model.apiModel,
          features: model.features,
          aspectRatios: model.aspectRatios,
          durations: model.durations,
          defaultAspectRatio: model.defaultAspectRatio,
          defaultDuration: model.defaultDuration,
          highlight: false,
          enabled: true,
          sortOrder: existingCount + created,
        });
        existingApiModels.add(model.apiModel);
        created += 1;
      } catch {
        skipped += 1;
        failed.push(model.apiModel);
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        total: classified.length,
        created,
        skipped,
        failed,
      },
    });
  } catch (error) {
    console.error('[API] Import flow2api video models error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '导入失败' },
      { status: 500 }
    );
  }
}
