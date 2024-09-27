/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as es from 'event-stream';
import * as gulp from 'gulp';
import * as concat from 'gulp-concat';
import * as filter from 'gulp-filter';
import * as path from 'path';
import * as fs from 'fs';
import * as pump from 'pump';
import * as VinylFile from 'vinyl';
import * as bundle from './bundle';
import { Language, processNlsFiles } from './i18n';
import * as util from './util';
import { gulpPostcss } from './postcss';
import * as esbuild from 'esbuild';
import * as sourcemaps from 'gulp-sourcemaps';

const REPO_ROOT_PATH = path.join(__dirname, '../..');

export interface IOptimizeAMDTaskOpts {
	/**
	 * The folder to read files from.
	 */
	src: string;
	/**
	 * (for AMD files, will get bundled and get Copyright treatment)
	 */
	entryPoints: bundle.IEntryPoint[];
	/**
	 * (svg, etc.)
	 */
	resources: string[];
	/**
	 * Additional info we append to the end of the loader
	 */
	externalLoaderInfo?: util.IExternalLoaderInfo;
	/**
	 * (true by default - append css and nls to loader)
	 */
	bundleLoader?: boolean;
	/**
	 * (basically the Copyright treatment)
	 */
	header?: string;
	/**
	 * (emit bundleInfo.json file)
	 */
	bundleInfo: boolean;
	/**
	 * Language configuration.
	 */
	languages?: Language[];
	/**
	 * File contents interceptor
	 * @param contents The contents of the file
	 * @param path The absolute file path, always using `/`, even on Windows
	 */
	fileContentMapper?: (contents: string, path: string) => string;
}

const DEFAULT_FILE_HEADER = [
	'/*!--------------------------------------------------------',
	' * Copyright (C) Microsoft Corporation. All rights reserved.',
	' *--------------------------------------------------------*/'
].join('\n');

function optimizeESMTask(opts: IOptimizeAMDTaskOpts, cjsOpts?: IOptimizeCommonJSTaskOpts): NodeJS.ReadWriteStream {
	const resourcesStream = es.through(); // this stream will contain the resources
	const bundlesStream = es.through(); // this stream will contain the bundled files

	const entryPoints = opts.entryPoints;
	if (cjsOpts) {
		cjsOpts.entryPoints.forEach(entryPoint => entryPoints.push({ name: path.parse(entryPoint).name }));
	}

	const allMentionedModules = new Set<string>();
	for (const entryPoint of entryPoints) {
		allMentionedModules.add(entryPoint.name);
		entryPoint.include?.forEach(allMentionedModules.add, allMentionedModules);
		entryPoint.exclude?.forEach(allMentionedModules.add, allMentionedModules);
	}

	allMentionedModules.delete('vs/css'); // TODO@esm remove this when vs/css is removed

	const bundleAsync = async () => {

		const files: VinylFile[] = [];
		const tasks: Promise<any>[] = [];

		for (const entryPoint of entryPoints) {

			console.log(`[bundle] '${entryPoint.name}'`);

			// support for 'dest' via esbuild#in/out
			const dest = entryPoint.dest?.replace(/\.[^/.]+$/, '') ?? entryPoint.name;

			// boilerplate massage
			const banner = {
				js: DEFAULT_FILE_HEADER,
				css: DEFAULT_FILE_HEADER
			};
			const tslibPath = path.join(require.resolve('tslib'), '../tslib.es6.js');
			banner.js += await fs.promises.readFile(tslibPath, 'utf-8');

			const boilerplateTrimmer: esbuild.Plugin = {
				name: 'boilerplate-trimmer',
				setup(build) {
					build.onLoad({ filter: /\.js$/ }, async args => {
						const contents = await fs.promises.readFile(args.path, 'utf-8');
						const newContents = bundle.removeAllTSBoilerplate(contents);
						return { contents: newContents };
					});
				}
			};

			// support for 'preprend' via the esbuild#banner
			if (entryPoint.prepend?.length) {
				for (const item of entryPoint.prepend) {
					const fullpath = path.join(REPO_ROOT_PATH, opts.src, item.path);
					const source = await fs.promises.readFile(fullpath, 'utf8');
					banner.js += source + '\n';
				}
			}

			const task = esbuild.build({
				bundle: true,
				external: entryPoint.exclude,
				packages: 'external', // "external all the things", see https://esbuild.github.io/api/#packages
				platform: 'neutral', // makes esm
				format: 'esm',
				sourcemap: 'external',
				plugins: [boilerplateTrimmer],
				target: ['es2022'],
				loader: {
					'.ttf': 'file',
					'.svg': 'file',
					'.png': 'file',
					'.sh': 'file',
				},
				assetNames: 'media/[name]', // moves media assets into a sub-folder "media"
				banner: entryPoint.name === 'vs/workbench/workbench.web.main' ? undefined : banner, // TODO@esm remove line when we stop supporting web-amd-esm-bridge
				entryPoints: [
					{
						in: path.join(REPO_ROOT_PATH, opts.src, `${entryPoint.name}.js`),
						out: dest,
					}
				],
				outdir: path.join(REPO_ROOT_PATH, opts.src),
				write: false, // enables res.outputFiles
				metafile: true, // enables res.metafile

			}).then(res => {
				for (const file of res.outputFiles) {

					let contents = file.contents;
					let sourceMapFile: esbuild.OutputFile | undefined = undefined;

					if (file.path.endsWith('.js')) {

						if (opts.fileContentMapper) {
							// UGLY the fileContentMapper is per file but at this point we have all files
							// bundled already. So, we call the mapper for the same contents but each file
							// that has been included in the bundle...
							let newText = file.text;
							for (const input of Object.keys(res.metafile.inputs)) {
								newText = opts.fileContentMapper(newText, input);
							}
							contents = Buffer.from(newText);
						}

						sourceMapFile = res.outputFiles.find(f => f.path === `${file.path}.map`);
					}

					const fileProps = {
						contents: Buffer.from(contents),
						sourceMap: sourceMapFile ? JSON.parse(sourceMapFile.text) : undefined, // support gulp-sourcemaps
						path: file.path,
						base: path.join(REPO_ROOT_PATH, opts.src)
					};
					files.push(new VinylFile(fileProps));
				}
			});

			// await task; // FORCE serial bundling (makes debugging easier)
			tasks.push(task);
		}

		await Promise.all(tasks);
		return { files };
	};

	bundleAsync().then((output) => {

		// bundle output (JS, CSS, SVG...)
		es.readArray(output.files).pipe(bundlesStream);

		// forward all resources
		gulp.src(opts.resources, { base: `${opts.src}`, allowEmpty: true }).pipe(resourcesStream);
	});

	const result = es.merge(
		bundlesStream,
		resourcesStream
	);

	return result
		.pipe(sourcemaps.write('./', {
			sourceRoot: undefined,
			addComment: true,
			includeContent: true
		}))
		.pipe(opts.languages && opts.languages.length ? processNlsFiles({
			out: opts.src,
			fileHeader: opts.header || DEFAULT_FILE_HEADER,
			languages: opts.languages
		}) : es.through());
}

export interface IOptimizeCommonJSTaskOpts {
	/**
	 * The paths to consider for optimizing.
	 */
	entryPoints: string[];
	/**
	 * The folder to read files from.
	 */
	src: string;
	/**
	 * ESBuild `platform` option: https://esbuild.github.io/api/#platform
	 */
	platform: 'browser' | 'node' | 'neutral';
	/**
	 * ESBuild `external` option: https://esbuild.github.io/api/#external
	 */
	external: string[];
}

export interface IOptimizeManualTaskOpts {
	/**
	 * The paths to consider for concatenation. The entries
	 * will be concatenated in the order they are provided.
	 */
	src: string[];
	/**
	 * Destination target to concatenate the entryPoints into.
	 */
	out: string;
}

function optimizeManualTask(options: IOptimizeManualTaskOpts[]): NodeJS.ReadWriteStream {
	const concatenations = options.map(opt => {
		return gulp
			.src(opt.src)
			.pipe(concat(opt.out));
	});

	return es.merge(...concatenations);
}

export interface IOptimizeTaskOpts {
	/**
	 * Destination folder for the optimized files.
	 */
	out: string;
	/**
	 * Optimize AMD modules (using our AMD loader).
	 */
	amd: IOptimizeAMDTaskOpts;
	/**
	 * Optimize CommonJS modules (using esbuild).
	 */
	commonJS?: IOptimizeCommonJSTaskOpts;
	/**
	 * Optimize manually by concatenating files.
	 */
	manual?: IOptimizeManualTaskOpts[];
}

export function optimizeTask(opts: IOptimizeTaskOpts): () => NodeJS.ReadWriteStream {
	return function () {
		const optimizers: NodeJS.ReadWriteStream[] = [];
		optimizers.push(optimizeESMTask(opts.amd, opts.commonJS));

		if (opts.manual) {
			optimizers.push(optimizeManualTask(opts.manual));
		}

		return es.merge(...optimizers).pipe(gulp.dest(opts.out));
	};
}

export function minifyTask(src: string, sourceMapBaseUrl?: string): (cb: any) => void {
	const sourceMappingURL = sourceMapBaseUrl ? ((f: any) => `${sourceMapBaseUrl}/${f.relative}.map`) : undefined;

	return cb => {
		const cssnano = require('cssnano') as typeof import('cssnano');
		const svgmin = require('gulp-svgmin') as typeof import('gulp-svgmin');

		const jsFilter = filter('**/*.js', { restore: true });
		const cssFilter = filter('**/*.css', { restore: true });
		const svgFilter = filter('**/*.svg', { restore: true });

		pump(
			gulp.src([src + '/**', '!' + src + '/**/*.map']),
			jsFilter,
			sourcemaps.init({ loadMaps: true }),
			es.map((f: any, cb) => {
				esbuild.build({
					entryPoints: [f.path],
					minify: true,
					sourcemap: 'external',
					outdir: '.',
					platform: 'node',
					target: ['es2022'],
					write: false
				}).then(res => {
					const jsFile = res.outputFiles.find(f => /\.js$/.test(f.path))!;
					const sourceMapFile = res.outputFiles.find(f => /\.js\.map$/.test(f.path))!;

					const contents = Buffer.from(jsFile.contents);
					const unicodeMatch = contents.toString().match(/[^\x00-\xFF]+/g);
					if (unicodeMatch) {
						cb(new Error(`Found non-ascii character ${unicodeMatch[0]} in the minified output of ${f.path}. Non-ASCII characters in the output can cause performance problems when loading. Please review if you have introduced a regular expression that esbuild is not automatically converting and convert it to using unicode escape sequences.`));
					} else {
						f.contents = contents;
						f.sourceMap = JSON.parse(sourceMapFile.text);

						cb(undefined, f);
					}
				}, cb);
			}),
			jsFilter.restore,
			cssFilter,
			gulpPostcss([cssnano({ preset: 'default' })]),
			cssFilter.restore,
			svgFilter,
			svgmin(),
			svgFilter.restore,
			sourcemaps.write('./', {
				sourceMappingURL,
				sourceRoot: undefined,
				includeContent: true,
				addComment: true
			} as any),
			gulp.dest(src + '-min'),
			(err: any) => cb(err));
	};
}
