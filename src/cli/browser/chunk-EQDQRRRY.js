/**
 * @license
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var p=Object.create;var j=Object.defineProperty,q=Object.defineProperties,r=Object.getOwnPropertyDescriptor,s=Object.getOwnPropertyDescriptors,t=Object.getOwnPropertyNames,g=Object.getOwnPropertySymbols,u=Object.getPrototypeOf,k=Object.prototype.hasOwnProperty,m=Object.prototype.propertyIsEnumerable;var l=(a,b,c)=>b in a?j(a,b,{enumerable:!0,configurable:!0,writable:!0,value:c}):a[b]=c,w=(a,b)=>{for(var c in b||={})k.call(b,c)&&l(a,c,b[c]);if(g)for(var c of g(b))m.call(b,c)&&l(a,c,b[c]);return a},x=(a,b)=>q(a,s(b));var y=(a,b)=>{var c={};for(var d in a)k.call(a,d)&&b.indexOf(d)<0&&(c[d]=a[d]);if(a!=null&&g)for(var d of g(a))b.indexOf(d)<0&&m.call(a,d)&&(c[d]=a[d]);return c};var z=(a,b)=>()=>(b||a((b={exports:{}}).exports,b),b.exports);var v=(a,b,c,d)=>{if(b&&typeof b=="object"||typeof b=="function")for(let e of t(b))!k.call(a,e)&&e!==c&&j(a,e,{get:()=>b[e],enumerable:!(d=r(b,e))||d.enumerable});return a};var A=(a,b,c)=>(c=a!=null?p(u(a)):{},v(b||!a||!a.__esModule?j(c,"default",{value:a,enumerable:!0}):c,a));var B=(a,b,c)=>new Promise((d,e)=>{var n=f=>{try{h(c.next(f))}catch(i){e(i)}},o=f=>{try{h(c.throw(f))}catch(i){e(i)}},h=f=>f.done?d(f.value):Promise.resolve(f.value).then(n,o);h((c=c.apply(a,b)).next())});export{w as a,x as b,y as c,z as d,A as e,B as f};
